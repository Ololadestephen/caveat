import { isRecord } from "../shape.ts";
import type { DecisionProvider } from "./provider.ts";
import { RELEASE_TIMING } from "./types.ts";
import type {
  DecisionOutcome,
  Excerpt,
  JevChoiceResult,
  JevGate,
  JevInfo,
  JevUsage,
  NeedsReviewReason,
  Question,
} from "./types.ts";

export type { JevChoiceResult, JevGate, JevInfo, JevUsage } from "./types.ts";

// TypeSafe's Jev via the TypeSafeAI Sprites Connector. Jev is a decision
// model, not chat: one POST /v1/systemone with {model, state, questions}; each
// question is "choice" (pick a criterion key) or "noul" (a probability for a
// yes/no statement). No free text, no response_format.
export const JEV_MODEL = "jev-1.14.0";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;

const RELEASE_TIMING_INSTRUCTIONS =
  "When does the consultant actually receive the cash compensation described in these excerpts?";
const RELEASE_TIMING_CRITERIA: Record<string, string> = {
  cash_on_fixed_date:
    "Cash is paid directly to the consultant on stated calendar dates.",
  escrow_release:
    "The money is first paid into escrow and reaches the consultant only when released on stated dates.",
  transaction_triggered:
    "Payment depends on a transaction event such as signing or closing a merger.",
  ambiguous: "The excerpts do not clearly support exactly one of these.",
};
const CITATION_INSTRUCTIONS =
  "Which excerpt most directly states when the consultant receives the cash compensation, including the payment or release dates?";
const GATE_INSTRUCTIONS =
  "The letter proposes exactly one change to the payment terms.";
export const JEV_GATE_QUESTION = "single_payment_change";

export type LetterGateOutcome =
  | { status: "pass"; gate: JevGate }
  // noul <= 0.2 — Jev is confident the letter is not a single change.
  | { status: "not_single"; gate: JevGate }
  // Between the bands — route to human review as low_confidence.
  | { status: "uncertain"; gate: JevGate }
  | { status: "failed"; reason: NeedsReviewReason; detail: string; model?: string };

export type JevProviderConfig = {
  gatewayBaseUrl: string;
  model?: string;
  threshold?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

// State is {excerpts: [{key, section, text}]}; keys are e1..eN because excerpt
// ids like "03-second-amendment.pdf#§2" are not safe as criteria keys.
function jevState(excerpts: Excerpt[]): { excerpts: { key: string; section: string; text: string }[] } {
  return {
    excerpts: excerpts.map((e, i) => ({
      key: `e${i + 1}`,
      section: e.source.section ?? e.id,
      text: e.text,
    })),
  };
}

function excerptKeys(excerpts: Excerpt[]): string[] {
  return excerpts.map((_, i) => `e${i + 1}`);
}

// The release-timing request: two choice questions in one call — the action
// and the excerpt that states it. Exported so the call digest covers exactly
// this payload.
export function buildReleaseTimingRequest(
  question: Question,
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> } {
  const sourceCriteria = Object.fromEntries(
    question.excerpts.map((e, i) => [
      `e${i + 1}`,
      `Excerpt e${i + 1} (${e.source.section ?? e.id})`,
    ]),
  );
  return {
    model,
    state: jevState(question.excerpts),
    questions: {
      release_timing: {
        type: "choice",
        instructions: RELEASE_TIMING_INSTRUCTIONS,
        criteria: { ...RELEASE_TIMING_CRITERIA },
      },
      release_timing_source: {
        type: "choice",
        instructions: CITATION_INSTRUCTIONS,
        criteria: sourceCriteria,
      },
    },
  };
}

// The client-letter gate request: one noul question over the reply excerpts.
export function buildGateRequest(
  excerpts: Excerpt[],
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> } {
  return {
    model,
    state: jevState(excerpts),
    questions: {
      [JEV_GATE_QUESTION]: { type: "noul", instructions: GATE_INSTRUCTIONS },
    },
  };
}

type PostResult =
  | {
      ok: true;
      model: string;
      answers: Record<string, unknown>;
      usage: JevUsage | undefined;
      latencyMs: number;
    }
  | { ok: false; reason: NeedsReviewReason; detail: string };

function parseChoice(
  raw: unknown,
  allowedKeys: string[],
): JevChoiceResult | undefined {
  if (
    !isRecord(raw) ||
    raw.type !== "choice" ||
    typeof raw.choice !== "string" ||
    !allowedKeys.includes(raw.choice) ||
    typeof raw.confidence !== "number" ||
    !isRecord(raw.probabilities) ||
    !Object.values(raw.probabilities).every((p) => typeof p === "number")
  ) {
    return undefined;
  }
  return {
    choice: raw.choice,
    confidence: raw.confidence,
    probabilities: raw.probabilities as Record<string, number>,
  };
}

export class JevDecisionProvider implements DecisionProvider {
  readonly name = "typesafe";
  private readonly gatewayBaseUrl: string;
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JevProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");
    this.model = config.model ?? JEV_MODEL;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async post(
    request: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<PostResult> {
    const start = Date.now();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal =
        options?.signal !== undefined
          ? AbortSignal.any([timeout, options.signal])
          : timeout;
      response = await this.fetchImpl(`${this.gatewayBaseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        ok: false,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { ok: false, reason: "http_error", detail: `systemone returned HTTP ${response.status}` };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, reason: "malformed_json", detail: "systemone response was not valid JSON" };
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.model !== "string" ||
      !isRecord(parsed.answers)
    ) {
      return {
        ok: false,
        reason: "schema_mismatch",
        detail: "systemone response lacked {model, answers}",
      };
    }
    const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
    return {
      ok: true,
      model: parsed.model,
      answers: parsed.answers,
      usage,
      latencyMs,
    };
  }

  async decide(
    question: Question,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionOutcome> {
    const fail = (
      reason: NeedsReviewReason,
      detail: string,
      extra?: { jev?: JevInfo },
    ): DecisionOutcome => ({
      status: "needs_review",
      reason,
      detail,
      provider: this.name,
      model: this.model,
      ...extra,
    });

    if (question.spec.id !== RELEASE_TIMING.id) {
      return fail("provider_error", `Jev cannot answer question ${question.spec.id}`);
    }

    const keys = excerptKeys(question.excerpts);
    const res = await this.post(buildReleaseTimingRequest(question, this.model), options);
    if (!res.ok) return fail(res.reason, res.detail);
    if (res.model !== this.model) {
      return fail("model_mismatch", `systemone answered with model ${res.model}, expected ${this.model}`);
    }
    const timing = parseChoice(res.answers.release_timing, Object.keys(RELEASE_TIMING_CRITERIA));
    const source = parseChoice(res.answers.release_timing_source, keys);
    if (timing === undefined || source === undefined) {
      return fail(
        "schema_mismatch",
        `systemone answers ${timing === undefined ? "release_timing" : "release_timing_source"} missing, not a choice answer, or named an unknown option`,
      );
    }
    const jev: JevInfo = {
      provider: "typesafe",
      model: res.model,
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
      questions: { release_timing: timing, release_timing_source: source },
    };

    if (timing.choice === "ambiguous") {
      return fail(
        "ambiguous",
        `Jev chose ambiguous (confidence ${timing.confidence.toFixed(2)})`,
        { jev },
      );
    }
    if (timing.confidence < this.threshold) {
      return fail(
        "low_confidence",
        `release_timing confidence ${timing.confidence.toFixed(2)} below ${this.threshold.toFixed(2)}`,
        { jev },
      );
    }
    if (source.confidence < this.threshold) {
      return fail(
        "low_confidence",
        `release_timing_source confidence ${source.confidence.toFixed(2)} below ${this.threshold.toFixed(2)}`,
        { jev },
      );
    }

    const excerpt = question.excerpts[keys.indexOf(source.choice)];
    if (excerpt === undefined) {
      return fail("schema_mismatch", `release_timing_source chose unknown key ${source.choice}`, { jev });
    }
    return {
      status: "decided",
      decision: {
        action: timing.choice,
        reason: "Jev choice; probabilities on the review page",
        cited_clause: { excerpt_id: excerpt.id, quote: excerpt.text },
        confidence: timing.confidence,
      },
      provider: this.name,
      model: res.model,
      jev,
      latencyMs: res.latencyMs,
    };
  }

  // The client-letter gate: one noul question over the reply excerpts. Pass at
  // noul >= threshold; a clear no (<= 0.2) is a different needs_review reason
  // than an undecided answer.
  async gateLetter(
    excerpts: Excerpt[],
    options?: { signal?: AbortSignal },
  ): Promise<LetterGateOutcome> {
    const res = await this.post(buildGateRequest(excerpts, this.model), options);
    if (!res.ok) {
      return { status: "failed", reason: res.reason, detail: res.detail };
    }
    if (res.model !== this.model) {
      return {
        status: "failed",
        reason: "model_mismatch",
        detail: `systemone answered with model ${res.model}, expected ${this.model}`,
        model: res.model,
      };
    }
    const raw = res.answers[JEV_GATE_QUESTION];
    if (
      !isRecord(raw) ||
      raw.type !== "noul" ||
      typeof raw.noul !== "number" ||
      raw.noul < 0 ||
      raw.noul > 1
    ) {
      return {
        status: "failed",
        reason: "schema_mismatch",
        detail: `systemone answers.${JEV_GATE_QUESTION} missing or not a noul answer`,
      };
    }
    const gate: JevGate = {
      noul: raw.noul,
      model: res.model,
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
    };
    if (gate.noul <= 0.2) return { status: "not_single", gate };
    if (gate.noul >= this.threshold) return { status: "pass", gate };
    return { status: "uncertain", gate };
  }
}
