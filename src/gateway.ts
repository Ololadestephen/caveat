import { isRecord } from "./shape.ts";

const GATEWAY_LIST_URL = "https://api.sprites.dev/v1/gateway/list";

export type Connection = { provider: string; gatewayBaseUrl: string; name?: string };

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
      // Custom-API connectors have no `name`; their label lives in
      // provider_account_name (and display_name). CAVEAT_WORKERS_CONNECTOR
      // matches whichever is present.
      const name =
        typeof entry.name === "string"
          ? entry.name
          : typeof entry.provider_account_name === "string"
            ? entry.provider_account_name
            : typeof entry.display_name === "string"
              ? entry.display_name
              : undefined;
      connections.push({
        provider: entry.provider,
        gatewayBaseUrl: entry.gateway_base_url,
        ...(name !== undefined ? { name } : {}),
      });
    }
  }
  return connections;
}
