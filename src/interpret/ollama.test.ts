import { describe, expect, it } from "vitest";
import { OllamaDecisionProvider } from "./ollama.ts";
import { DECISION_JSON_SCHEMA } from "./schema.ts";
import type { BillingTriggerQuestion, DecisionOutcome } from "./types.ts";

const PINNED_MODEL = "test-model";

const QUESTION: BillingTriggerQuestion = {
  questionId: "q-billing",
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

function envelope(content: string | undefined, model: string | null = PINNED_MODEL): string {
  const message: Record<string, unknown> = { role: "assistant" };
  if (content !== undefined) message.content = content;
  const body: Record<string, unknown> = { done: true, message };
  if (model !== null) body.model = model;
  return JSON.stringify(body);
}

function stubFetch(response: Response | (() => Promise<Response>)): typeof fetch {
  return () => Promise.resolve(typeof response === "function" ? response() : response);
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provider(fetchImpl: typeof fetch, overrides: { threshold?: number; timeoutMs?: number } = {}) {
  return new OllamaDecisionProvider({
    gatewayBaseUrl: "http://gateway.invalid/",
    model: PINNED_MODEL,
    fetch: fetchImpl,
    ...overrides,
  });
}

function okDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_DECISION, ...overrides });
}

function rejectReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("aborted");
}

describe("OllamaDecisionProvider", () => {
  it("decides on a valid response and sends a strict structured request", async () => {
    let seenUrl: unknown;
    let seenInit: RequestInit | undefined;
    const capture = ((_url: unknown, init?: RequestInit) => {
      seenUrl = _url;
      seenInit = init;
      return Promise.resolve(jsonResponse(envelope(okDecision())));
    }) as typeof fetch;

    const outcome = await provider(capture).decide(QUESTION);
    expect(outcome.status).toBe("decided");
    if (outcome.status === "decided") {
      expect(outcome.decision).toEqual(VALID_DECISION);
      expect(outcome.provider).toBe("ollama");
      expect(outcome.model).toBe(PINNED_MODEL);
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }

    expect(seenUrl).toBe("http://gateway.invalid/api/chat");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    const body = JSON.parse(seenInit?.body as string) as Record<string, unknown>;
    expect(body.model).toBe(PINNED_MODEL);
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(DECISION_JSON_SCHEMA);
    expect((body.options as Record<string, unknown>).temperature).toBe(0);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain(QUESTION.excerpts[0]?.text);
  });

  it.each([
    ["ambiguous action", okDecision({ action: "ambiguous" }), "ambiguous"],
    [
      "confidence below threshold",
      okDecision({ confidence: 0.79 }),
      "low_confidence",
    ],
    [
      "extra top-level key",
      JSON.stringify({ ...VALID_DECISION, extra: 1 }),
      "schema_mismatch",
    ],
    [
      "missing required key",
      JSON.stringify({
        action: VALID_DECISION.action,
        cited_clause: VALID_DECISION.cited_clause,
        confidence: VALID_DECISION.confidence,
      }),
      "schema_mismatch",
    ],
    [
      "extra cited_clause key",
      okDecision({
        cited_clause: { ...VALID_DECISION.cited_clause, note: "x" },
      }),
      "schema_mismatch",
    ],
    ["wrong action enum", okDecision({ action: "maybe" }), "schema_mismatch"],
    ["wrong confidence type", okDecision({ confidence: "high" }), "schema_mismatch"],
    [
      "confidence out of range",
      okDecision({ confidence: 1.5 }),
      "schema_mismatch",
    ],
    [
      "reason over 500 chars",
      okDecision({ reason: "x".repeat(501) }),
      "schema_mismatch",
    ],
    [
      "quote over 600 chars",
      okDecision({
        cited_clause: { excerpt_id: "ex-1", quote: "x".repeat(601) },
      }),
      "schema_mismatch",
    ],
    [
      "decision not an object",
      JSON.stringify([1, 2, 3]),
      "schema_mismatch",
    ],
    [
      "unknown excerpt id",
      okDecision({
        cited_clause: { excerpt_id: "ex-9", quote: "anything" },
      }),
      "unknown_excerpt",
    ],
    [
      "quote not verbatim",
      okDecision({
        cited_clause: { excerpt_id: "ex-1", quote: "not in the excerpt" },
      }),
      "quote_not_verbatim",
    ],
    [
      "empty quote",
      okDecision({ cited_clause: { excerpt_id: "ex-1", quote: "" } }),
      "quote_not_verbatim",
    ],
  ])("routes %s to needs_review", async (_label, content, expectedReason) => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope(content))),
    ).decide(QUESTION);
    expect(outcome.status).toBe("needs_review");
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe(expectedReason);
      expect(outcome.provider).toBe("ollama");
      expect(outcome.model).toBe(PINNED_MODEL);
    }
  });

  it("routes malformed JSON content to needs_review", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope("{not json"))),
    ).decide(QUESTION);
    expect(outcome.status).toBe("needs_review");
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("malformed_json");
  });

  it("routes a non-JSON envelope to needs_review", async () => {
    const outcome = await provider(
      stubFetch(new Response("not json", { status: 200 })),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("malformed_json");
    else expect.unreachable();
  });

  it("routes a response missing message.content to needs_review", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope(undefined))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("malformed_json");
    else expect.unreachable();
  });

  it.each([
    ["different model", "other-model"],
    ["missing model", null],
  ])("routes %s to needs_review as model_mismatch", async (_label, model) => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope(okDecision(), model))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("model_mismatch");
    else expect.unreachable();
  });

  it("routes non-2xx HTTP to needs_review without exposing the body", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse("secret-server-error-body", 500)),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("http_error");
      expect(outcome.detail).toContain("500");
      expect(outcome.detail).not.toContain("secret-server-error-body");
    } else expect.unreachable();
  });

  it("routes aborts to needs_review as timeout", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(rejectReason(init.signal?.reason));
        });
      })) as typeof fetch;
    const outcome = await provider(hanging, { timeoutMs: 10 }).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("timeout");
    else expect.unreachable();
  });

  it("routes fetch failures to needs_review as network_error", async () => {
    const failing = (() =>
      Promise.reject(new TypeError("fetch failed: socket hang up"))) as typeof fetch;
    const outcome = await provider(failing).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("network_error");
    else expect.unreachable();
  });

  it("honours a configurable confidence threshold", async () => {
    const outcome = await provider(stubFetch(jsonResponse(envelope(okDecision({ confidence: 0.6 })))), {
      threshold: 0.5,
    }).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("accepts confidence exactly at the threshold", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope(okDecision({ confidence: 0.8 })))),
    ).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("routes a caller-aborted signal to needs_review as timeout", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(rejectReason(init.signal?.reason));
        });
      })) as typeof fetch;
    const controller = new AbortController();
    const promise = provider(hanging).decide(QUESTION, { signal: controller.signal });
    controller.abort();
    const outcome: DecisionOutcome = await promise;
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("timeout");
    else expect.unreachable();
  });
});
