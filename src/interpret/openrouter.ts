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

export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;
const ERROR_MESSAGE_MAX = 200;

export type OpenRouterProviderConfig = {
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

function truncate(value: string, max = ERROR_MESSAGE_MAX): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
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

type EmbeddedError = { code: unknown; message: string | undefined };

function embeddedError(body: Record<string, unknown>): EmbeddedError | undefined {
  if (!isRecord(body.error)) return undefined;
  return {
    code: body.error.code,
    message: typeof body.error.message === "string" ? body.error.message : undefined,
  };
}

function describeEmbedded(prefix: string, error: EmbeddedError): string {
  const parts = [prefix];
  if (typeof error.code === "string" || typeof error.code === "number") {
    parts.push(`code ${String(error.code)}`);
  }
  if (error.message !== undefined) parts.push(truncate(error.message));
  return parts.join("; ");
}

export class OpenRouterDecisionProvider implements DecisionProvider {
  readonly name = "openrouter";
  private readonly gatewayBaseUrl: string;
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly allowedModelVersions: string[] | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenRouterProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_OPENROUTER_MODEL;
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
      extra?: { modelVersion?: string; servedBy?: string; decision?: Decision },
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
      model: this.model,
      messages: [
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        { role: "user", content: buildDecisionUserPrompt(question) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "billing_trigger_decision",
          strict: true,
          schema: DECISION_JSON_SCHEMA,
        },
      },
      provider: { require_parameters: true },
      temperature: 0,
      stream: false,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayBaseUrl}/v1/chat/completions`, {
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
    const body = isRecord(envelope) ? envelope : undefined;

    if (response.status === 429) {
      const parts = ["chat/completions returned HTTP 429"];
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) parts.push(`retry-after: ${retryAfter}`);
      const err = body !== undefined ? embeddedError(body) : undefined;
      if (err?.message !== undefined) parts.push(truncate(err.message));
      return fail("rate_limited", parts.join("; "));
    }
    if (response.status === 408) {
      return fail("timeout", "chat/completions returned HTTP 408 request timeout");
    }
    if (!response.ok) {
      const err = body !== undefined ? embeddedError(body) : undefined;
      const detail = `chat/completions returned HTTP ${response.status}`;
      return fail(
        "http_error",
        err?.message === undefined ? detail : `${detail}; ${truncate(err.message)}`,
      );
    }
    if (body === undefined) {
      return fail("malformed_json", "response body was not valid JSON");
    }

    const topError = embeddedError(body);
    const choice: unknown = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const choiceError = isRecord(choice) && isRecord(choice.error)
      ? { code: choice.error.code, message: typeof choice.error.message === "string" ? choice.error.message : undefined }
      : undefined;
    const embedded = topError ?? choiceError;
    if (embedded !== undefined) {
      if (embedded.code === 429) {
        return fail("rate_limited", describeEmbedded("provider reported an error", embedded));
      }
      return fail("provider_error", describeEmbedded("provider reported an error", embedded));
    }

    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const refusal =
      message !== undefined && typeof message.refusal === "string" && message.refusal.length > 0
        ? message.refusal
        : undefined;
    const finishReason =
      isRecord(choice) && typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
    if (finishReason === "length") {
      return fail("truncated", "response hit the length finish reason");
    }
    if (finishReason === "content_filter" || refusal !== undefined) {
      return fail(
        "blocked",
        refusal !== undefined ? `provider refused: ${truncate(refusal)}` : "response blocked by content filter",
      );
    }
    if (finishReason === "error") {
      return fail("provider_error", "generation finished with the error finish reason");
    }
    if (finishReason !== undefined && finishReason !== "stop") {
      return fail("malformed_json", `unexpected finish reason ${finishReason}`);
    }

    const content =
      message !== undefined && typeof message.content === "string" && message.content.length > 0
        ? message.content
        : undefined;
    if (content === undefined) {
      return fail("malformed_json", "response contained no assistant content");
    }

    const modelVersion =
      typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
    if (modelVersion === undefined) {
      return fail("missing_model_version", "response did not include a resolved model");
    }
    if (this.allowedModelVersions !== undefined && !this.allowedModelVersions.includes(modelVersion)) {
      return fail(
        "model_mismatch",
        `resolved model ${JSON.stringify(modelVersion)} is not in the allowed model versions`,
        { modelVersion },
      );
    }
    const servedBy = typeof body.provider === "string" && body.provider.length > 0 ? body.provider : undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail("malformed_json", "assistant content was not valid JSON", {
        modelVersion,
        ...(servedBy !== undefined ? { servedBy } : {}),
      });
    }

    const result = validateDecision(parsed, question, this.threshold);
    const context = {
      modelVersion,
      ...(servedBy !== undefined ? { servedBy } : {}),
    };
    if (!result.ok) {
      return fail(result.reason, result.detail, {
        ...context,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
      });
    }
    return {
      status: "decided",
      decision: result.decision,
      provider: this.name,
      model: this.model,
      ...context,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
