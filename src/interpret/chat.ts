import { isRecord } from "../shape.ts";
import type { NeedsReviewReason } from "./types.ts";

export type StructuredChatConfig = {
  gatewayBaseUrl: string;
  timeoutMs: number;
  allowedModelVersions?: string[];
  fetch?: typeof fetch;
};

// Providers keep their config as fields; this builds the request config once.
export function chatConfig(
  gatewayBaseUrl: string,
  timeoutMs: number,
  allowedModelVersions: string[] | undefined,
  fetchImpl: typeof fetch,
): StructuredChatConfig {
  return {
    gatewayBaseUrl,
    timeoutMs,
    ...(allowedModelVersions !== undefined ? { allowedModelVersions } : {}),
    fetch: fetchImpl,
  };
}

export type StructuredChatRequest = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
};

export type ChatResult =
  | {
      ok: true;
      parsed: unknown;
      modelVersion: string;
      servedBy?: string;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: NeedsReviewReason;
      detail: string;
      modelVersion?: string;
      servedBy?: string;
    };

const ERROR_MESSAGE_MAX = 200;

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

// One POST to {gateway}/v1/chat/completions with a strict JSON schema plus the
// shared fail-closed mapping for transport and envelope errors. Domain
// validation of the parsed payload is the caller's job.
export async function callStructuredChat(
  config: StructuredChatConfig,
  request: StructuredChatRequest,
  options?: { signal?: AbortSignal },
): Promise<ChatResult> {
  const fetchImpl = config.fetch ?? fetch;
  const started = performance.now();
  const fail = (
    reason: NeedsReviewReason,
    detail: string,
    extra?: { modelVersion?: string; servedBy?: string },
  ): ChatResult => ({ ok: false, reason, detail, ...extra });

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal =
    options?.signal !== undefined
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;

  const requestBody = {
    model: request.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: request.schema },
    },
    provider: { require_parameters: true },
    temperature: 0,
    stream: false,
  };

  let response: Response;
  try {
    response = await fetchImpl(`${config.gatewayBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
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
  const choiceError =
    isRecord(choice) && isRecord(choice.error)
      ? {
          code: choice.error.code,
          message: typeof choice.error.message === "string" ? choice.error.message : undefined,
        }
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
      refusal !== undefined
        ? `provider refused: ${truncate(refusal)}`
        : "response blocked by content filter",
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
  if (
    config.allowedModelVersions !== undefined &&
    !config.allowedModelVersions.includes(modelVersion)
  ) {
    return fail(
      "model_mismatch",
      `resolved model ${JSON.stringify(modelVersion)} is not in the allowed model versions`,
      { modelVersion },
    );
  }
  const servedBy =
    typeof body.provider === "string" && body.provider.length > 0 ? body.provider : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fail("malformed_json", "assistant content was not valid JSON", {
      modelVersion,
      ...(servedBy !== undefined ? { servedBy } : {}),
    });
  }

  return {
    ok: true,
    parsed,
    modelVersion,
    ...(servedBy !== undefined ? { servedBy } : {}),
    latencyMs: Math.round(performance.now() - started),
  };
}
