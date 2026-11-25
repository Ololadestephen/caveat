import { afterEach, describe, expect, it, vi } from "vitest";

import { listConnections } from "./gateway.ts";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("listConnections", () => {
  it("maps provider and gateway_base_url, skipping malformed entries", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        respond({
          connections: [
            { provider: "box", gateway_base_url: "https://gw/box" },
            { gateway_base_url: "https://gw/no-provider" },
            { provider: "x" },
            "not-an-object",
          ],
        }),
      ),
    );
    const connections = await listConnections();
    expect(connections).toEqual([
      { provider: "box", gatewayBaseUrl: "https://gw/box" },
    ]);
  });

  it("finds the connector name from name, provider_account_name or display_name", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        respond({
          connections: [
            {
              provider: "custom_api",
              name: "direct-name",
              provider_account_name: "fallback",
              gateway_base_url: "https://gw/a",
            },
            {
              provider: "custom_api",
              provider_account_name: "caveat-workers",
              display_name: "caveat-workers",
              gateway_base_url: "https://gw/workers",
            },
            {
              provider: "openrouter",
              display_name: "only-display",
              gateway_base_url: "https://gw/or",
            },
          ],
        }),
      ),
    );
    const connections = await listConnections();
    expect(connections[0]?.name).toBe("direct-name");
    // The custom_api entry exposes no `name` — discovery must fall back.
    const workers = connections.find((c) => c.name === "caveat-workers");
    expect(workers?.gatewayBaseUrl).toBe("https://gw/workers");
    expect(connections[2]?.name).toBe("only-display");
  });

  it("throws when the gateway list call fails", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(respond({}, 500)));
    await expect(listConnections()).rejects.toThrow("HTTP 500");
  });
});
