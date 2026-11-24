import { describe, expect, it } from "vitest";
import { GeminiDecisionProvider } from "./gemini.ts";
import { DECISION_JSON_SCHEMA } from "./schema.ts";
import type { BillingTriggerQuestion } from "./types.ts";

const ALIAS = "gemini-flash-latest";
const RESOLVED = "gemini-3-flash";

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

type EnvelopeOptions = {
  parts?: unknown[];
  finishReason?: string | null;
  blockReason?: string;
  modelVersion?: string | null;
  candidates?: unknown[];
};

function envelope(options: EnvelopeOptions = {}): string {
  const body: Record<string, unknown> = {};
  if (options.candidates !== undefined) {
    body.candidates = options.candidates;
  } else {
    const candidate: Record<string, unknown> = {
      content: {
        role: "model",
        parts: options.parts ?? [{ text: JSON.stringify(VALID_DECISION) }],
      },
    };
    if (options.finishReason !== null) {
      candidate.finishReason = options.finishReason ?? "STOP";
    }
    body.candidates = [candidate];
  }
  if (options.blockReason !== undefined) {
    body.promptFeedback = { blockReason: options.blockReason };
  }
  if (options.modelVersion !== null) {
    body.modelVersion = options.modelVersion ?? RESOLVED;
  }
  return JSON.stringify(body);
}

function jsonResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(response: Response | (() => Promise<Response>)): typeof fetch {
  return () => Promise.resolve(typeof response === "function" ? response() : response);
}

function provider(
  fetchImpl: typeof fetch,
  overrides: { threshold?: number; timeoutMs?: number; allowedModelVersions?: string[] } = {},
) {
  return new GeminiDecisionProvider({
    gatewayBaseUrl: "http://gateway.invalid/",
    fetch: fetchImpl,
    ...overrides,
  });
}

function validText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_DECISION, ...overrides });
}

describe("GeminiDecisionProvider", () => {
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
      expect(outcome.provider).toBe("gemini");
      expect(outcome.model).toBe(ALIAS);
      expect(outcome.modelVersion).toBe(RESOLVED);
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }

    expect(seenUrl).toBe(`http://gateway.invalid/v1beta/models/${ALIAS}:generateContent`);
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();

    const body = JSON.parse(seenInit?.body as string) as Record<string, unknown>;
    expect(body.systemInstruction).toBeDefined();
    const contents = body.contents as { role: string }[];
    expect(contents[0]?.role).toBe("user");
    const generationConfig = body.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBe("application/json");
    expect(generationConfig.responseJsonSchema).toEqual(DECISION_JSON_SCHEMA);
    const rawBody = seenInit?.body as string;
    expect(rawBody).not.toContain("temperature");
    expect(rawBody).not.toContain("topP");
    expect(rawBody).not.toContain("topK");
  });

  it("ignores thought parts when assembling the answer", async () => {
    const outcome = await provider(
      stubFetch(
        jsonResponse(
          envelope({
            parts: [
              { thought: true, text: "internal reasoning not part of the answer" },
              { text: validText() },
            ],
          }),
        ),
      ),
    ).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("joins multiple text parts", async () => {
    const first = validText().slice(0, 40);
    const second = validText().slice(40);
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ parts: [{ text: first }, { text: second }] }))),
    ).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("routes HTTP 429 to rate_limited with retry-after and Google status", async () => {
    const outcome = await provider(
      stubFetch(
        jsonResponse(
          JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }),
          429,
          { "retry-after": "42" },
        ),
      ),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("rate_limited");
      expect(outcome.detail).toContain("429");
      expect(outcome.detail).toContain("42");
      expect(outcome.detail).toContain("RESOURCE_EXHAUSTED");
    } else expect.unreachable();
  });

  it("routes HTTP 429 without extras to rate_limited", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse("unparseable", 429)),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("rate_limited");
      expect(outcome.detail).toContain("429");
    } else expect.unreachable();
  });

  it("routes other non-2xx HTTP to http_error without exposing the body", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse("secret-server-error-body", 500)),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("http_error");
      expect(outcome.detail).toContain("500");
      expect(outcome.detail).not.toContain("secret-server-error-body");
    } else expect.unreachable();
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

  it("routes promptFeedback.blockReason to blocked", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ blockReason: "SAFETY" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("blocked");
      expect(outcome.detail).toContain("SAFETY");
    } else expect.unreachable();
  });

  it.each(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "OTHER", "LANGUAGE"])(
    "routes finishReason %s to blocked",
    async (finishReason) => {
      const outcome = await provider(
        stubFetch(jsonResponse(envelope({ finishReason }))),
      ).decide(QUESTION);
      if (outcome.status === "needs_review") {
        expect(outcome.reason).toBe("blocked");
        expect(outcome.detail).toContain(finishReason);
      } else expect.unreachable();
    },
  );

  it("routes finishReason MAX_TOKENS to truncated", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason: "MAX_TOKENS" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("truncated");
    else expect.unreachable();
  });

  it("routes an unknown non-STOP finishReason to blocked", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ finishReason: "MALFORMED_FUNCTION_CALL" }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("blocked");
      expect(outcome.detail).toContain("MALFORMED_FUNCTION_CALL");
    } else expect.unreachable();
  });

  it.each([
    ["no candidates", envelope({ candidates: [] })],
    ["no parts", envelope({ parts: [] })],
    ["only thought parts", envelope({ parts: [{ thought: true, text: "x" }] })],
    ["non-JSON text", envelope({ parts: [{ text: "{not json" }] })],
    ["non-JSON body", "not json at all"],
  ])("routes %s to malformed_json", async (_label, body) => {
    const outcome = await provider(stubFetch(jsonResponse(body))).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("malformed_json");
    else expect.unreachable();
  });

  it.each([
    ["missing modelVersion", envelope({ modelVersion: null })],
    ["empty modelVersion", envelope({ modelVersion: "" })],
  ])("routes %s to missing_model_version", async (_label, body) => {
    const outcome = await provider(stubFetch(jsonResponse(body))).decide(QUESTION);
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("missing_model_version");
    else expect.unreachable();
  });

  it("routes a disallowed resolved modelVersion to model_mismatch", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope())),
      { allowedModelVersions: ["gemini-2-flash"] },
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("model_mismatch");
      expect(outcome.detail).toContain(RESOLVED);
      expect(outcome.modelVersion).toBe(RESOLVED);
    } else expect.unreachable();
  });

  it("accepts an allowed resolved modelVersion", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope())),
      { allowedModelVersions: [RESOLVED] },
    ).decide(QUESTION);
    expect(outcome.status).toBe("decided");
  });

  it("still routes provider-invalid decisions to needs_review", async () => {
    const outcome = await provider(
      stubFetch(jsonResponse(envelope({ parts: [{ text: validText({ confidence: 0.1 }) }] }))),
    ).decide(QUESTION);
    if (outcome.status === "needs_review") {
      expect(outcome.reason).toBe("low_confidence");
      expect(outcome.model).toBe(ALIAS);
      expect(outcome.modelVersion).toBe(RESOLVED);
    } else expect.unreachable();
  });

  it("uses the configured model in the request URL", async () => {
    let seenUrl: unknown;
    const capture = ((_url: unknown) => {
      seenUrl = _url;
      return Promise.resolve(jsonResponse(envelope()));
    }) as typeof fetch;
    const outcome = await new GeminiDecisionProvider({
      gatewayBaseUrl: "http://gateway.invalid",
      model: "gemini-3-flash",
      fetch: capture,
    }).decide(QUESTION);
    expect(seenUrl).toBe("http://gateway.invalid/v1beta/models/gemini-3-flash:generateContent");
    expect(outcome.status).toBe("decided");
    if (outcome.status === "decided") expect(outcome.model).toBe("gemini-3-flash");
  });
});
