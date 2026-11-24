import { isRecord } from "./shape.ts";

const GATEWAY_LIST_URL = "https://api.sprites.dev/v1/gateway/list";

export type Connection = { provider: string; gatewayBaseUrl: string };

export async function listConnections(options: { fetch?: typeof fetch } = {}): Promise<
  Connection[]
> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(GATEWAY_LIST_URL);
  if (!response.ok) throw new Error(`gateway list returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new Error("gateway list response lacked connections");
  }
  const connections: Connection[] = [];
  for (const entry of body.connections) {
    if (
      isRecord(entry) &&
      typeof entry.provider === "string" &&
      typeof entry.gateway_base_url === "string"
    ) {
      connections.push({ provider: entry.provider, gatewayBaseUrl: entry.gateway_base_url });
    }
  }
  return connections;
}
