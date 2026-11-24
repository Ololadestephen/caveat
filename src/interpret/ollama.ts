import { DECISION_JSON_SCHEMA } from "./schema.ts";
import { validateDecision } from "./validate.ts";
import type { DecisionProvider } from "./provider.ts";
import type {
  BillingTriggerQuestion,
  Decision,
  DecisionOutcome,
  NeedsReviewReason,
} from "./types.ts";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = [
  "You decide a billing-trigger question about supplied contract excerpts.",
  "Answer only from the supplied excerpts; never use outside knowledge.",
  "Quote the cited clause verbatim from one supplied excerpt.",
  "Choose \"ambiguous\" whenever the excerpts do not clearly support a single action.",
  "Do no arithmetic, set no prices, and do not predict payment behaviour.",
  "confidence is your self-reported confidence from 0 to 1, not a calibrated probability.",
  "Respond with a single JSON object matching the requested schema.",
].join("\n");

export type OllamaProviderConfig = {
  gatewayBaseUrl: string;
  model: string;
  threshold?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildUserPrompt(question: BillingTriggerQuestion): string {
  const excerpts = question.excerpts
    .map(
      (e) =>
        `<excerpt id="${e.id}" file="${e.source.fileName}" version="${e.source.versionLabel}" page="${e.source.page}">\n${e.text}\n</excerpt>`,
    )
    .join("\n");
  return [
    `Question ${question.questionId}: does the contract text trigger billing on delivery,`,
    "on client acceptance, or is it ambiguous?",
    "",
    excerpts,
  ].join("\n");
}

function classifyError(error: unknown): NeedsReviewReason {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "network_error";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export class OllamaDecisionProvider implements DecisionProvider {
  readonly name = "ollama";
  private readonly gatewayBaseUrl: string;
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OllamaProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async decide(
    question: BillingTriggerQuestion,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionOutcome> {
    const started = performance.now();
    const fail = (
      reason: NeedsReviewReason,
      detail: string,
      extra?: { model?: string; decision?: Decision },
    ): DecisionOutcome => ({
      status: "needs_review",
      reason,
      detail,
      provider: this.name,
      ...extra,
    });

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      options?.signal !== undefined
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

    const requestBody = {
      model: this.model,
      stream: false,
      format: DECISION_JSON_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(question) },
      ],
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (error) {
      return fail(classifyError(error), describeError(error));
    }

    if (!response.ok) {
      return fail("http_error", `ollama /api/chat returned HTTP ${response.status}`);
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      return fail("malformed_json", "response body was not valid JSON");
    }

    const responseModel =
      isRecord(envelope) && typeof envelope.model === "string" ? envelope.model : undefined;
    if (responseModel !== this.model) {
      return fail(
        "model_mismatch",
        `response model ${responseModel === undefined ? "is missing" : JSON.stringify(responseModel)} does not match pinned model ${JSON.stringify(this.model)}`,
        responseModel === undefined ? {} : { model: responseModel },
      );
    }

    const content =
      isRecord(envelope) && isRecord(envelope.message) && typeof envelope.message.content === "string"
        ? envelope.message.content
        : undefined;
    if (content === undefined) {
      return fail("malformed_json", "response is missing message.content", { model: responseModel });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail("malformed_json", "message.content was not valid JSON", {
        model: responseModel,
      });
    }

    const result = validateDecision(parsed, question, this.threshold);
    if (!result.ok) {
      return fail(result.reason, result.detail, {
        model: responseModel,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
      });
    }
    return {
      status: "decided",
      decision: result.decision,
      provider: this.name,
      model: responseModel,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
