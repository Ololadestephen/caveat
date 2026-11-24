import { DECISION_JSON_SCHEMA } from "./schema.ts";
import { validateDecision } from "./validate.ts";
import { DECISION_SYSTEM_PROMPT, buildDecisionUserPrompt } from "./prompt.ts";
import type { DecisionProvider } from "./provider.ts";
import type {
  BillingTriggerQuestion,
  Decision,
  DecisionOutcome,
  NeedsReviewReason,
} from "./types.ts";

const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 30_000;

export type GeminiProviderConfig = {
  gatewayBaseUrl: string;
  model?: string;
  threshold?: number;
  timeoutMs?: number;
  allowedModelVersions?: string[];
  fetch?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function googleErrorStatus(body: unknown): string | undefined {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.status === "string") {
    return body.error.status;
  }
  return undefined;
}

function responseText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.candidates) || body.candidates.length === 0) {
    return undefined;
  }
  const candidate: unknown = body.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const part of candidate.content.parts) {
    if (isRecord(part) && part.thought !== true && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  const joined = texts.join("");
  return joined.length > 0 ? joined : undefined;
}

export class GeminiDecisionProvider implements DecisionProvider {
  readonly name = "gemini";
  private readonly gatewayBaseUrl: string;
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly allowedModelVersions: string[] | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowedModelVersions = config.allowedModelVersions;
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
      extra?: { modelVersion?: string; decision?: Decision },
    ): DecisionOutcome => ({
      status: "needs_review",
      reason,
      detail,
      provider: this.name,
      model: this.model,
      ...extra,
    });

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      options?.signal !== undefined
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

    const requestBody = {
      systemInstruction: { parts: [{ text: DECISION_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: buildDecisionUserPrompt(question) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: DECISION_JSON_SCHEMA,
      },
    };

    const url = `${this.gatewayBaseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (error) {
      return fail(classifyError(error), describeError(error));
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      envelope = undefined;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const googleStatus = googleErrorStatus(envelope);
      const parts = ["generateContent returned HTTP 429"];
      if (retryAfter !== null) parts.push(`retry-after: ${retryAfter}`);
      if (googleStatus !== undefined) parts.push(`status: ${googleStatus}`);
      return fail("rate_limited", parts.join("; "));
    }
    if (!response.ok) {
      const googleStatus = googleErrorStatus(envelope);
      const detail = `generateContent returned HTTP ${response.status}`;
      return fail("http_error", googleStatus === undefined ? detail : `${detail}; status: ${googleStatus}`);
    }
    if (!isRecord(envelope)) {
      return fail("malformed_json", "response body was not valid JSON");
    }

    const blockReason =
      isRecord(envelope.promptFeedback) && typeof envelope.promptFeedback.blockReason === "string"
        ? envelope.promptFeedback.blockReason
        : undefined;
    if (blockReason !== undefined && blockReason.length > 0) {
      return fail("blocked", `prompt blocked by provider: ${blockReason}`);
    }

    const candidate: unknown = Array.isArray(envelope.candidates) ? envelope.candidates[0] : undefined;
    const finishReason =
      isRecord(candidate) && typeof candidate.finishReason === "string"
        ? candidate.finishReason
        : undefined;
    if (finishReason !== undefined && finishReason !== "STOP" && finishReason !== "FINISH_REASON_UNSPECIFIED") {
      if (finishReason === "MAX_TOKENS") {
        return fail("truncated", "response hit the MAX_TOKENS finish reason");
      }
      return fail("blocked", `provider finished with reason ${finishReason}`);
    }

    const text = responseText(envelope);
    if (text === undefined) {
      return fail("malformed_json", "response contained no candidate text");
    }

    const modelVersion =
      typeof envelope.modelVersion === "string" && envelope.modelVersion.length > 0
        ? envelope.modelVersion
        : undefined;
    if (modelVersion === undefined) {
      return fail("missing_model_version", "response did not include a modelVersion");
    }
    if (this.allowedModelVersions !== undefined && !this.allowedModelVersions.includes(modelVersion)) {
      return fail(
        "model_mismatch",
        `resolved modelVersion ${JSON.stringify(modelVersion)} is not in the allowed model versions`,
        { modelVersion },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("malformed_json", "candidate text was not valid JSON", { modelVersion });
    }

    const result = validateDecision(parsed, question, this.threshold);
    if (!result.ok) {
      return fail(result.reason, result.detail, {
        modelVersion,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
      });
    }
    return {
      status: "decided",
      decision: result.decision,
      provider: this.name,
      model: this.model,
      modelVersion,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
