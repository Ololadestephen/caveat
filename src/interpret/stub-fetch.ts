// Shared fetch stub for provider tests: records calls and replays a fixed
// payload — a ready Response, a function producing one, or a JSON body.
export type StubCall = { url: string; init: RequestInit | undefined };

export function stubChatFetch(
  payload: unknown,
  init: { status?: number } = {},
): { impl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = ((url: unknown, initObj?: unknown) => {
    calls.push({ url: String(url), init: initObj as RequestInit | undefined });
    if (payload instanceof Response) return Promise.resolve(payload);
    if (typeof payload === "function") {
      return (payload as () => Promise<Response>)();
    }
    return Promise.resolve(
      new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}
