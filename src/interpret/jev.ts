import { isRecord } from "../shape.ts";
import type { DecisionProvider } from "./provider.ts";
import { RELEASE_TIMING } from "./types.ts";
import type { ValidatedRelease } from "./schedule.ts";
import type { ValidatedTerm } from "./payment-terms.ts";
import type { ClientCounterTexts } from "./client-counter.ts";
import type { Lever } from "../search/levers.ts";
import type {
  DecisionOutcome,
  Excerpt,
  JevChoiceResult,
  JevCrosscheck,
  JevGate,
  JevInfo,
  JevQuestionResult,
  JevUsage,
  NeedsReviewReason,
  Question,
} from "./types.ts";

export type {
  JevChoiceResult,
  JevCrosscheck,
  JevGate,
  JevInfo,
  JevQuestionResult,
  JevUsage,
} from "./types.ts";

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
// The citation question is asked only after the decision, so its wording can
// name the exact clause the decision relies on.
const SOURCE_INSTRUCTIONS_BY_ACTION: Record<string, string> = {
  cash_on_fixed_date:
    "Which excerpt states the first calendar date on which cash is paid directly to the Consultant?",
  escrow_release:
    "Which excerpt states the date of the first release of escrowed money to the Consultant that does not depend on any extension or other condition?",
  transaction_triggered:
    "Which excerpt states the transaction event that triggers payment to the Consultant?",
};
const GATE_INSTRUCTIONS =
  "The letter proposes exactly one change to the payment terms.";
export const JEV_GATE_QUESTION = "single_payment_change";

// The schedule cross-check restates each extracted release's conditionality
// as a noul claim over its own quote; Jev must agree with the extraction's
// conditional/unconditional label.
function scheduleCrosscheckInstructions(amountText: string): string {
  return `The quoted clause makes the payment of ${amountText} conditional on an extension or another condition.`;
}

export const COUNTER_CROSSCHECK_QUESTION = "counter_proposal";

// The counter cross-check restates the extracted proposal in the lever's own
// shape, using the model's verbatim text fields, over the citation quote.
function counterCrosscheckInstructions(
  lever: Lever,
  texts: ClientCounterTexts,
): string | undefined {
  switch (lever) {
    case "upfront_deposit":
      return texts.amount_text !== undefined && texts.date_text !== undefined
        ? `The sentence proposes paying ${texts.amount_text} to the consultant as an upfront deposit on ${texts.date_text}.`
        : undefined;
    case "earlier_release":
      return texts.amount_text !== undefined && texts.date_text !== undefined
        ? `The sentence proposes releasing ${texts.amount_text} from escrow early, on ${texts.date_text}.`
        : undefined;
    case "milestone_split":
      return texts.amount_text !== undefined &&
        texts.split_count_text !== undefined &&
        texts.date_text !== undefined
        ? `The sentence proposes paying ${texts.amount_text} in ${texts.split_count_text} monthly parts, the first on ${texts.date_text}.`
        : undefined;
    case "shorter_payment_terms":
      return texts.net_days_text !== undefined
        ? `The sentence proposes paying each month's fees ${texts.net_days_text} after the month ends.`
        : undefined;
  }
}

export type CrosscheckOutcome =
  | { status: "pass"; checks: JevCrosscheck[] }
  // Jev clearly disagreed with the extraction (noul in the opposite band).
  | { status: "mismatch"; checks: JevCrosscheck[]; detail: string }
  // Between the bands — route to human review as low_confidence.
  | { status: "uncertain"; checks: JevCrosscheck[]; detail: string }
  | { status: "failed"; reason: NeedsReviewReason; detail: string };

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

function sourceCriteria(excerpts: Excerpt[]): Record<string, string> {
  return Object.fromEntries(
    excerpts.map((e, i) => [
      `e${i + 1}`,
      `Excerpt e${i + 1} (${e.source.section ?? e.id})`,
    ]),
  );
}

// The release-timing request: one choice question. The citation is a second
// request, asked only after a confident non-ambiguous answer, because the
// right clause to cite depends on the chosen action.
export function buildReleaseTimingRequest(
  question: Question,
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> } {
  return {
    model,
    state: jevState(question.excerpts),
    questions: {
      release_timing: {
        type: "choice",
        instructions: RELEASE_TIMING_INSTRUCTIONS,
        criteria: { ...RELEASE_TIMING_CRITERIA },
      },
    },
  };
}

// The citation request for a decided action. Callers must pass one of the
// criteria keys — the switch on timing.choice guards it before this is built.
export function buildSourceRequest(
  excerpts: Excerpt[],
  action: string,
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> } {
  const instructions = SOURCE_INSTRUCTIONS_BY_ACTION[action];
  if (instructions === undefined) {
    throw new Error(`no source instructions for action ${action}`);
  }
  return {
    model,
    state: jevState(excerpts),
    questions: {
      release_timing_source: {
        type: "choice",
        instructions,
        criteria: sourceCriteria(excerpts),
      },
    },
  };
}

// What the release-timing call digest covers: both questions, with all three
// action-specific citation instruction strings — the one actually sent
// depends on the answer, so a matching digest must commit to all of them.
export function buildReleaseTimingDigestInput(
  question: Question,
  model: string,
): Record<string, unknown> {
  return {
    provider: "typesafe",
    decisionRequest: buildReleaseTimingRequest(question, model),
    sourceRequest: {
      model,
      state: jevState(question.excerpts),
      question: "release_timing_source",
      instructionsByAction: { ...SOURCE_INSTRUCTIONS_BY_ACTION },
      criteria: sourceCriteria(question.excerpts),
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

// The schedule cross-check requests: one noul question per release. A request
// carries a single state, so releases citing the same quote share a request
// and releases citing different quotes each get their own.
export function buildScheduleCrosscheckRequests(
  releases: ValidatedRelease[],
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> }[] {
  const byQuote = new Map<string, ValidatedRelease[]>();
  for (const r of releases) {
    const group = byQuote.get(r.quote);
    if (group === undefined) byQuote.set(r.quote, [r]);
    else group.push(r);
  }
  return [...byQuote.entries()].map(([quote, group]) => ({
    model,
    state: { quote },
    questions: Object.fromEntries(
      group.map((r) => [
        `release_${r.id}`,
        { type: "noul", instructions: scheduleCrosscheckInstructions(r.amountText) },
      ]),
    ),
  }));
}

// The counter cross-check request: one noul question over the citation quote,
// restating the proposal in the lever's own shape. Undefined when the stored
// texts cannot build the instruction — the caller treats that as a failure.
export function buildCounterCrosscheckRequest(
  lever: Lever,
  texts: ClientCounterTexts,
  quote: string,
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> } | undefined {
  const instructions = counterCrosscheckInstructions(lever, texts);
  if (instructions === undefined) return undefined;
  return {
    model,
    state: { quote },
    questions: {
      [COUNTER_CROSSCHECK_QUESTION]: { type: "noul", instructions },
    },
  };
}

// The per-term cross-check instruction restates the extraction's own texts so
// Jev can verify them against the quote. Undefined when the term lacks the
// fields its kind's instruction needs — the caller treats that as a failure.
function termCrosscheckInstructions(term: ValidatedTerm): string | undefined {
  switch (term.kind) {
    case "fixed_date_payment": {
      const when = term.dateText ?? term.recurrenceText;
      if (term.amountText === null || when === null) return undefined;
      const recurrence = term.recurrenceText === null ? "" : ` ${term.recurrenceText}`;
      return `The quoted clause sets a cash fee of ${term.amountText}${recurrence}, paid or invoiced ${when}.`;
    }
    case "deposit":
      if (term.amountText === null || term.dateText === null) return undefined;
      return `The quoted clause requires a payment of ${term.amountText} ${term.dateText}.`;
    case "payment_terms":
      if (term.netDaysText === null) return undefined;
      return `The quoted clause gives the client ${term.netDaysText} to pay an invoice.`;
    case "escrow_release":
      if (term.amountText === null || term.dateText === null) return undefined;
      return `The quoted clause releases ${term.amountText} from escrow ${term.dateText}.`;
  }
}

// One systemone request per distinct quote — a single request carries one
// state, so terms citing the same quote share it. Undefined when any term
// cannot build its instruction.
export function buildTermCrosscheckRequests(
  terms: ValidatedTerm[],
  model: string,
): { model: string; state: unknown; questions: Record<string, unknown> }[] | undefined {
  const byQuote = new Map<string, ValidatedTerm[]>();
  for (const t of terms) {
    const group = byQuote.get(t.quote);
    if (group === undefined) byQuote.set(t.quote, [t]);
    else group.push(t);
  }
  const requests: { model: string; state: unknown; questions: Record<string, unknown> }[] = [];
  for (const [quote, group] of byQuote) {
    const questions: Record<string, unknown> = {};
    for (const t of group) {
      const instructions = termCrosscheckInstructions(t);
      if (instructions === undefined) return undefined;
      questions[`term_${t.id}`] = { type: "noul", instructions };
    }
    requests.push({ model, state: { quote }, questions });
  }
  return requests;
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

function parseNoul(raw: unknown): number | undefined {
  return isRecord(raw) &&
    raw.type === "noul" &&
    typeof raw.noul === "number" &&
    raw.noul >= 0 &&
    raw.noul <= 1
    ? raw.noul
    : undefined;
}

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
    // Each answered question lands here under its name, with the model and
    // usage of the request that produced it.
    const answered: Record<string, JevQuestionResult> = {};
    const jev = (): JevInfo => ({ provider: "typesafe", questions: { ...answered } });
    const record = (name: string, q: JevChoiceResult, res: { model: string; usage: JevUsage | undefined }): void => {
      answered[name] = {
        ...q,
        model: res.model,
        ...(res.usage !== undefined ? { usage: res.usage } : {}),
      };
    };

    const res = await this.post(buildReleaseTimingRequest(question, this.model), options);
    if (!res.ok) return fail(res.reason, res.detail);
    if (res.model !== this.model) {
      return fail("model_mismatch", `systemone answered with model ${res.model}, expected ${this.model}`);
    }
    const timing = parseChoice(res.answers.release_timing, Object.keys(RELEASE_TIMING_CRITERIA));
    if (timing === undefined) {
      return fail(
        "schema_mismatch",
        "systemone answers.release_timing missing, not a choice answer, or named an unknown option",
      );
    }
    record("release_timing", timing, res);

    if (timing.choice === "ambiguous") {
      return fail(
        "ambiguous",
        `Jev chose ambiguous (confidence ${timing.confidence.toFixed(2)})`,
        { jev: jev() },
      );
    }
    if (timing.confidence < this.threshold) {
      return fail(
        "low_confidence",
        `release_timing confidence ${timing.confidence.toFixed(2)} below ${this.threshold.toFixed(2)}`,
        { jev: jev() },
      );
    }

    // The citation is a second request whose wording depends on the action.
    const res2 = await this.post(
      buildSourceRequest(question.excerpts, timing.choice, this.model),
      options,
    );
    if (!res2.ok) return fail(res2.reason, res2.detail, { jev: jev() });
    if (res2.model !== this.model) {
      return fail("model_mismatch", `systemone answered with model ${res2.model}, expected ${this.model}`, { jev: jev() });
    }
    const source = parseChoice(res2.answers.release_timing_source, keys);
    if (source === undefined) {
      return fail(
        "schema_mismatch",
        "systemone answers.release_timing_source missing, not a choice answer, or named an unknown option",
        { jev: jev() },
      );
    }
    record("release_timing_source", source, res2);
    if (source.confidence < this.threshold) {
      return fail(
        "low_confidence",
        `release_timing_source confidence ${source.confidence.toFixed(2)} below ${this.threshold.toFixed(2)}`,
        { jev: jev() },
      );
    }

    const excerpt = question.excerpts[keys.indexOf(source.choice)];
    if (excerpt === undefined) {
      return fail("schema_mismatch", `release_timing_source chose unknown key ${source.choice}`, { jev: jev() });
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
      jev: jev(),
      latencyMs: res.latencyMs + res2.latencyMs,
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
    const noul = parseNoul(res.answers[JEV_GATE_QUESTION]);
    if (noul === undefined) {
      return {
        status: "failed",
        reason: "schema_mismatch",
        detail: `systemone answers.${JEV_GATE_QUESTION} missing or not a noul answer`,
      };
    }
    const gate: JevGate = {
      noul,
      model: res.model,
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
    };
    if (gate.noul <= 0.2) return { status: "not_single", gate };
    if (gate.noul >= this.threshold) return { status: "pass", gate };
    return { status: "uncertain", gate };
  }

  // The schedule cross-check: one noul per release over its own quote,
  // batched per distinct quote. Jev must land in the band the extraction's
  // conditional label implies; a clear opposite answer is a mismatch, the
  // middle band is undecided. The first disagreement stops the check.
  async crosscheckSchedule(
    releases: ValidatedRelease[],
    options?: { signal?: AbortSignal },
  ): Promise<CrosscheckOutcome> {
    const releaseFor = new Map(releases.map((r) => [`release_${r.id}`, r]));
    const checks: JevCrosscheck[] = [];
    for (const request of buildScheduleCrosscheckRequests(releases, this.model)) {
      const res = await this.post(request, options);
      if (!res.ok) return { status: "failed", reason: res.reason, detail: res.detail };
      if (res.model !== this.model) {
        return {
          status: "failed",
          reason: "model_mismatch",
          detail: `systemone answered with model ${res.model}, expected ${this.model}`,
        };
      }
      for (const name of Object.keys(request.questions)) {
        const release = releaseFor.get(name);
        const noul = parseNoul(res.answers[name]);
        if (release === undefined || noul === undefined) {
          return {
            status: "failed",
            reason: "schema_mismatch",
            detail: `systemone answers.${name} missing or not a noul answer`,
          };
        }
        checks.push({
          question: name,
          noul,
          model: res.model,
          ...(res.usage !== undefined ? { usage: res.usage } : {}),
        });
        const label = release.conditional ? "conditional" : "unconditional";
        const opposite = release.conditional ? noul <= 0.2 : noul >= this.threshold;
        const passing = release.conditional ? noul >= this.threshold : noul <= 0.2;
        if (opposite) {
          return {
            status: "mismatch",
            checks,
            detail: `Jev disagreed on ${release.id}: the extraction marked it ${label} but p(conditional) = ${noul.toFixed(2)}`,
          };
        }
        if (!passing) {
          return {
            status: "uncertain",
            checks,
            detail: `Jev could not confirm ${release.id} as ${label} (p(conditional) = ${noul.toFixed(2)})`,
          };
        }
      }
    }
    return { status: "pass", checks };
  }

  // The counter cross-check: one noul over the citation quote restating the
  // extracted proposal. The sentence should match, so the bands mirror the
  // gate's: clear at the threshold passes, a clear no is a mismatch.
  async crosscheckCounter(
    args: { lever: Lever; texts: ClientCounterTexts; quote: string },
    options?: { signal?: AbortSignal },
  ): Promise<CrosscheckOutcome> {
    const request = buildCounterCrosscheckRequest(
      args.lever,
      args.texts,
      args.quote,
      this.model,
    );
    if (request === undefined) {
      return {
        status: "failed",
        reason: "schema_mismatch",
        detail: "the stored counter texts cannot build the cross-check instruction",
      };
    }
    const res = await this.post(request, options);
    if (!res.ok) return { status: "failed", reason: res.reason, detail: res.detail };
    if (res.model !== this.model) {
      return {
        status: "failed",
        reason: "model_mismatch",
        detail: `systemone answered with model ${res.model}, expected ${this.model}`,
      };
    }
    const noul = parseNoul(res.answers[COUNTER_CROSSCHECK_QUESTION]);
    if (noul === undefined) {
      return {
        status: "failed",
        reason: "schema_mismatch",
        detail: `systemone answers.${COUNTER_CROSSCHECK_QUESTION} missing or not a noul answer`,
      };
    }
    const check: JevCrosscheck = {
      question: COUNTER_CROSSCHECK_QUESTION,
      noul,
      model: res.model,
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
    };
    if (noul <= 0.2) {
      return {
        status: "mismatch",
        checks: [check],
        detail: `Jev decided the sentence does not propose the extracted change (p = ${noul.toFixed(2)})`,
      };
    }
    if (noul >= this.threshold) return { status: "pass", checks: [check] };
    return {
      status: "uncertain",
      checks: [check],
      detail: `Jev could not confirm the extracted change (p = ${noul.toFixed(2)})`,
    };
  }

  // The payment-terms cross-check: one noul per extracted term over its own
  // quote, batched per distinct quote. The instruction restates the extracted
  // texts, so Jev should agree — a clear no is a mismatch naming the term, the
  // middle band is undecided. The first disagreement stops the check.
  async crosscheckPaymentTerms(
    terms: ValidatedTerm[],
    options?: { signal?: AbortSignal },
  ): Promise<CrosscheckOutcome> {
    const requests = buildTermCrosscheckRequests(terms, this.model);
    if (requests === undefined) {
      return {
        status: "failed",
        reason: "schema_mismatch",
        detail: "an extracted term lacks the texts its cross-check instruction needs",
      };
    }
    const termFor = new Map(terms.map((t) => [`term_${t.id}`, t]));
    const checks: JevCrosscheck[] = [];
    for (const request of requests) {
      const res = await this.post(request, options);
      if (!res.ok) return { status: "failed", reason: res.reason, detail: res.detail };
      if (res.model !== this.model) {
        return {
          status: "failed",
          reason: "model_mismatch",
          detail: `systemone answered with model ${res.model}, expected ${this.model}`,
        };
      }
      for (const name of Object.keys(request.questions)) {
        const term = termFor.get(name);
        const noul = parseNoul(res.answers[name]);
        if (term === undefined || noul === undefined) {
          return {
            status: "failed",
            reason: "schema_mismatch",
            detail: `systemone answers.${name} missing or not a noul answer`,
          };
        }
        checks.push({
          question: name,
          noul,
          model: res.model,
          ...(res.usage !== undefined ? { usage: res.usage } : {}),
        });
        if (noul <= 0.2) {
          return {
            status: "mismatch",
            checks,
            detail: `Jev disagreed on ${term.id}: the extraction's restated clause was rejected (p = ${noul.toFixed(2)})`,
          };
        }
        if (noul < this.threshold) {
          return {
            status: "uncertain",
            checks,
            detail: `Jev could not confirm ${term.id} (p = ${noul.toFixed(2)})`,
          };
        }
      }
    }
    return { status: "pass", checks };
  }
}
