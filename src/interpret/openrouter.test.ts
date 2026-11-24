import { describe, expect, it } from "vitest";
import { stubChatFetch } from "./stub-fetch.ts";
import { DEFAULT_OPENROUTER_MODEL, OpenRouterDecisionProvider } from "./openrouter.ts";
import { decisionSchema } from "./schema.ts";
import { BILLING_TRIGGER } from "./types.ts";
import type { Question } from "./types.ts";

const MODEL = DEFAULT_OPENROUTER_MODEL;
const RESOLVED = "nvidia/nemotron-3.5-super-vl";
const SERVED_BY = "Nvidia";

const QUESTION: Question = {
  spec: BILLING_TRIGGER,
  id: "q-billing",
  excerpts: [
    {
      id: "ex-1",
      text: "Payment of the milestone fee is due upon the Client's written acceptance of the Deliverables.",
      source: { fileName: "sow.pdf", versionLabel: "v1", page: 3 },
    },
  ],
};

const VALID_DECISION = {
  action: "acceptance_triggered",
  reason: "Payment is due on written acceptance.",
  cited_clause: {
    excerpt_id: "ex-1",
    quote: "due upon the Client's written acceptance",
  },
  confidence: 0.95,
};

type EnvelopeOptions = {
  content?: string | null;
  finishReason?: string | null;
  refusal?: string;
  model?: string | null;
  provider?: string | null;
  choices?: unknown[] | null;
  error?: unknown;
  message?: Record<string, unknown>;
};

function envelope(options: EnvelopeOptions = {}): string {
  const body: Record<string, unknown> = {};
  if (options.choices === null) {
    body.choices = [];
  } else {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: options.content === undefined ? JSON.stringify(VALID_DECISION) : options.content,
      ...options.message,
    };
    if (options.refusal !== undefined) message.refusal = options.refusal;
    const choice: Record<string, unknown> = { index: 0, message };
    if (options.finishReason !== null) {
      choice.finish_reason = options.finishReason ?? "stop";
    }
    body.choices = options.choices ?? [choice];
  }
  if (options.error !== undefined) body.error = options.error;
  if (options.model !== null) body.model = options.model ?? RESOLVED;
  if (options.provider !== null) body.provider = options.provider ?? SERVED_BY;
  return JSON.stringify(body);
}

function jsonResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const stubFetch = (response: Response | (() => Promise<Response>)): typeof fetch =>
  stubChatFetch(response).impl;

function provider(
  fetchImpl: typeof fetch,
  overrides: { threshold?: number; timeoutMs?: number; allowedModelVersions?: string[]; model?: string } = {},
) {
  return new OpenRouterDecisionProvider({
    gatewayBaseUrl: "http://gateway.invalid/",
    fetch: fetchImpl,
    ...overrides,
  });
}

function validText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_DECISION, ...overrides });
}

describe("OpenRouterDecisionProvider", () => {
  it("decides on a valid response and sends a strict structured request", async () => {
    let seenUrl: unknown;
    let seenInit: RequestInit | undefined;
    const capture = ((_url: unknown, init?: RequestInit) => {
      seenUrl = _url;
      seenInit = init;
      return Promise.resolve(jsonResponse(envelope()));
    }) as typeof fetch;

    const outcome = await provider(capture).decide(QUESTION);
    expect(outcome.status).toBe("decided");
    if (outcome.status === "decided") {
      expect(outcome.decision).toEqual(VALID_DECISION);
      expect(outcome.provider).toBe("openrouter");
      expect(outcome.model).toBe(MODEL);
      expect(outcome.modelVersion).toBe(RESOLVED);
      expect(outcome.servedBy).toBe(SERVED_BY);
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }

    expect(seenUrl).toBe("http://gateway.invalid/v1/chat/completions");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();

    const body = JSON.parse(seenInit?.body as string) as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "billing_trigger_decision",
        strict: true,
        schema: decisionSchema(BILLING_TRIGGER.actions),
      },
    });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain(QUESTION.excerpts[0]?.text);
  });

  it("changes only the model field when swapped to typesafe/jev-router", async () => {
    const bodies: string[] = [];
    const capture = ((_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return Promise.resolve(jsonResponse(envelope()));
    }) as typeof fetch;
    await provider(capture).decide(QUESTION);
    await provider(capture, { model: "typesafe/jev-router" }).decide(QUESTION);
    const first = JSON.parse(bodies[0] as string) as Record<string, unknown>;
    const second = JSON.parse(bodies[1] as string) as Record<string, unknown>;
    expect(second.model).toBe("typesafe/jev-router");
    const rest = { ...second, model: first.model };
    expect(rest).toEqual(first);
  });

  it("routes HTTP 429 to rate_limited with retry-after and truncated message", async () => {
    const longMessage = "quota exceeded " + "x".repeat(400);
    const outcome = await provider(
      stubFetch(
        jsonResponse(
          JSON.stringify({ error: { code: 429, message: longMessage } }),
          429,
          { "retry-after": "17" },
        ),
      ),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("rate_limited");
      expect(outcome.detail).toContain("429");
      expect(outcome.detail).toContain("17");
      expect(outcome.detail.length).toBeLessThan(300);
    } else expect.unreachable();
  });

  it("routes HTTP 408 to timeout", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(JSON.stringify({ error: { code: 408 } }), 408)),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("timeout");
    else expect.unreachable();
  });

  it("surfaces the data-policy 404 message verbatim as http_error", async () => {
    const outcome = await provider(
      stubFetch(
        jsonResponse(
          JSON.stringify({
            error: { code: 404, message: "No endpoints found matching your data policy" },
          }),
          404,
        ),
      ),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("http_error");
      expect(outcome.detail).toContain("No endpoints found matching your data policy");
    } else expect.unreachable();
  });

  it("routes other non-2xx HTTP to http_error", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(JSON.stringify({ error: { code: 502, message: "bad upstream" } }), 502)),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("http_error");
      expect(outcome.detail).toContain("502");
      expect(outcome.detail).toContain("bad upstream");
    } else expect.unreachable();
  });

  it("routes a top-level in-200 error with code 429 to rate_limited", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ error: { code: 429, message: "rate limited" } }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("rate_limited");
    else expect.unreachable();
  });

  it("routes a top-level in-200 error to provider_error", async () => {
    const outcome = await provider(
      stubFetch(
        jsonResponse(envelope({ error: { code: 503, message: "upstream provider failed" } })),
      ),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("provider_error");
      expect(outcome.detail).toContain("503");
      expect(outcome.detail).toContain("upstream provider failed");
    } else expect.unreachable();
  });

  it("routes an in-200 choices[0].error to provider_error", async () => {
    const outcome = await provider(
      stubFetch(
        jsonResponse(
          envelope({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "" },
                finish_reason: "error",
                error: { code: 500, message: "generation blew up" },
              },
            ],
          }),
        ),
      ),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("provider_error");
      expect(outcome.detail).toContain("generation blew up");
    } else expect.unreachable();
  });

  it("routes finish_reason length to truncated", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason: "length" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("truncated");
    else expect.unreachable();
  });

  it("routes finish_reason content_filter to blocked", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason: "content_filter" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("blocked");
    else expect.unreachable();
  });

  it("routes a non-empty message.refusal to blocked", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ refusal: "I cannot answer that." }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("blocked");
      expect(outcome.detail).toContain("cannot answer");
    } else expect.unreachable();
  });

  it("routes finish_reason error to provider_error", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason: "error" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("provider_error");
    else expect.unreachable();
  });

  it.each([
    ["tool_calls", "tool_calls"],
    ["unexpected finish", "function_call"],
  ])("routes finish_reason %s to malformed_json", async (_label, finishReason) => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("malformed_json");
      expect(outcome.detail).toContain(finishReason);
    } else expect.unreachable();
  });

  it.each([
    ["no choices", envelope({ choices: null })],
    ["empty content", envelope({ content: "" })],
    ["null content", envelope({ content: null })],
    ["non-JSON content", envelope({ content: "{not json" })],
    ["non-JSON body", "not json at all"],
  ])("routes %s to malformed_json", async (_label, body) => {
    const outcome = await provider(stubFetch(jsonResponse(body))).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("malformed_json");
    else expect.unreachable();
  });

  it.each([
    ["missing model", envelope({ model: null })],
    ["empty model", envelope({ model: "" })],
  ])("routes %s to missing_model_version", async (_label, body) => {
    const outcome = await provider(stubFetch(jsonResponse(body))).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("missing_model_version");
    else expect.unreachable();
  });

  it("routes a disallowed resolved model to model_mismatch", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope())),
      { allowedModelVersions: ["some/other-model"] },
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("model_mismatch");
      expect(outcome.modelVersion).toBe(RESOLVED);
    } else expect.unreachable();
  });

  it("accepts an allowed resolved model", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope())),
      { allowedModelVersions: [RESOLVED] },
    ).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("routes aborts to timeout", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
        });
      })) as typeof fetch;
    const outcome = await provider(hanging, { timeoutMs: 10 }).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("timeout");
    else expect.unreachable();
  });

  it("routes fetch failures to network_error", async () => {
    const failing = (() =>
      Promise.reject(new TypeError("fetch failed: socket hang up"))) as typeof fetch;
    const outcome = await provider(failing).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("network_error");
    else expect.unreachable();
  });

  it("still routes invalid decisions to needs_review with provider context", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ content: validText({ confidence: 0.1 }) }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("low_confidence");
      expect(outcome.model).toBe(MODEL);
      expect(outcome.modelVersion).toBe(RESOLVED);
      expect(outcome.servedBy).toBe(SERVED_BY);
    } else expect.unreachable();
  });
});
