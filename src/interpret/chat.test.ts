import { describe, expect, it } from "vitest";
import { callStructuredChat } from "./chat.ts";
import type { StructuredChatRequest } from "./chat.ts";
import { stubChatFetch } from "./stub-fetch.ts";

const REQUEST: StructuredChatRequest = {
  model: "test-model",
  systemPrompt: "sys",
  userPrompt: "user",
  schemaName: "test_schema",
  schema: { type: "object" },
};

const CONFIG = { gatewayBaseUrl: "http://gw.invalid/", timeoutMs: 5000 };

function envelope(content: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "resolved-model",
    provider: "TestProvider",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content) },
      },
    ],
    ...overrides,
  });
}

describe("callStructuredChat", () => {
  it("posts the strict schema request and parses assistant content", async () => {
    const { impl, calls } = stubChatFetch(envelope({ answer: 1 }));
    const out = await callStructuredChat({ ...CONFIG, fetch: impl }, REQUEST);
    expect(out).toMatchObject({
      ok: true,
      parsed: { answer: 1 },
      modelVersion: "resolved-model",
      servedBy: "TestProvider",
    });
    const call = calls[0];
    expect(call?.url).toBe("http://gw.invalid/v1/chat/completions");
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      response_format: {
        type: "json_schema",
        json_schema: { name: "test_schema", strict: true, schema: { type: "object" } },
      },
      provider: { require_parameters: true },
      temperature: 0,
      stream: false,
    });
  });

  it("maps HTTP statuses to fail-closed reasons", async () => {
    const cases: [number, string, string][] = [
      [429, "rate_limited", "retry-after: 30"],
      [408, "timeout", "HTTP 408"],
      [502, "http_error", "HTTP 502"],
    ];
    for (const [status, reason, detailPart] of cases) {
      const { impl } = stubChatFetch(
        new Response(JSON.stringify({ error: { code: status, message: "boom" } }), {
          status,
          headers: { "retry-after": "30" },
        }),
      );
      const out = await callStructuredChat({ ...CONFIG, fetch: impl }, REQUEST);
      if (out.ok) return expect.unreachable();
      expect(out.reason).toBe(reason);
      expect(out.detail).toContain(detailPart);
    }
  });

  it("maps envelope and content failures", async () => {
    const bad = await callStructuredChat(
      { ...CONFIG, fetch: stubChatFetch("not json").impl },
      REQUEST,
    );
    expect(bad).toMatchObject({ ok: false, reason: "malformed_json" });

    const providerErr = await callStructuredChat(
      { ...CONFIG, fetch: stubChatFetch(envelope({}, { error: { code: 500, message: "kaput" } })).impl },
      REQUEST,
    );
    expect(providerErr).toMatchObject({ ok: false, reason: "provider_error" });

    const truncated = await callStructuredChat(
      {
        ...CONFIG,
        fetch: stubChatFetch(
          JSON.stringify({ model: "m", choices: [{ finish_reason: "length", message: {} }] }),
        ).impl,
      },
      REQUEST,
    );
    expect(truncated).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("requires a resolved model and honours the allow-list", async () => {
    const noModel = await callStructuredChat(
      {
        ...CONFIG,
        fetch: stubChatFetch(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
        ).impl,
      },
      REQUEST,
    );
    expect(noModel).toMatchObject({ ok: false, reason: "missing_model_version" });

    const wrongModel = await callStructuredChat(
      { ...CONFIG, allowedModelVersions: ["other"], fetch: stubChatFetch(envelope({})).impl },
      REQUEST,
    );
    expect(wrongModel).toMatchObject({ ok: false, reason: "model_mismatch" });
  });

  it("maps a throwing fetch to a fail-closed reason", async () => {
    const timeout = await callStructuredChat(
      {
        ...CONFIG,
        fetch: (() => {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          return Promise.reject(e);
        }) as typeof fetch,
      },
      REQUEST,
    );
    expect(timeout).toMatchObject({ ok: false, reason: "timeout" });

    const net = await callStructuredChat(
      { ...CONFIG, fetch: (() => Promise.reject(new Error("dns"))) as typeof fetch },
      REQUEST,
    );
    expect(net).toMatchObject({ ok: false, reason: "network_error" });
  });
});
