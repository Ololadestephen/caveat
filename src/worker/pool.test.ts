import { describe, expect, it } from "vitest";
import {
  InProcessPool,
  parseExecStream,
  SpritesExecPool,
  WorkerUnavailableError,
} from "./pool.ts";

const enc = new TextEncoder();

// tag 0x01 stdout / 0x02 stderr / 0x03 + one exit-code byte, raw bytes between
// tags — frames split wherever the writer flushes.
function framed(parts: { tag: number; bytes: number[] }[], exit: number | null): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    out.push(part.tag, ...part.bytes);
  }
  if (exit !== null) out.push(0x03, exit);
  return new Uint8Array(out);
}

describe("parseExecStream", () => {
  it("collects stdout and the exit code", () => {
    const stream = parseExecStream(framed([{ tag: 0x01, bytes: [...enc.encode('{"a":1}')] }], 0));
    expect(new TextDecoder().decode(stream.stdout)).toBe('{"a":1}');
    expect(stream.exitCode).toBe(0);
    expect(stream.stderr.length).toBe(0);
  });

  it("handles interleaved stdout and stderr", () => {
    const stream = parseExecStream(
      framed(
        [
          { tag: 0x01, bytes: [...enc.encode("out1")] },
          { tag: 0x02, bytes: [...enc.encode("err\n")] },
          { tag: 0x01, bytes: [...enc.encode("out2")] },
        ],
        3,
      ),
    );
    expect(new TextDecoder().decode(stream.stdout)).toBe("out1out2");
    expect(new TextDecoder().decode(stream.stderr)).toBe("err\n");
    expect(stream.exitCode).toBe(3);
  });

  it("joins stdout frames split at arbitrary boundaries", () => {
    const payload = enc.encode(`{"results":[${"x".repeat(200_000)}]}`);
    const parts = [];
    for (let i = 0; i < payload.length; i += 32768) {
      parts.push({ tag: 0x01, bytes: [...payload.slice(i, i + 32768)] });
    }
    const stream = parseExecStream(framed(parts, 0));
    expect(stream.stdout.length).toBe(payload.length);
    expect(new TextDecoder().decode(stream.stdout)).toBe(`{"results":[${"x".repeat(200_000)}]}`);
  });

  it("reports a missing exit frame as null", () => {
    const stream = parseExecStream(framed([{ tag: 0x01, bytes: [65] }], null));
    expect(stream.exitCode).toBeNull();
  });
});

function fakeFetch(
  responder: (url: string, body: string) => { status: number; body: Uint8Array },
): typeof fetch {
  const calls: { url: string; body: string }[] = [];
  const impl = ((url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: String(url), body });
    const res = responder(String(url), body);
    return Promise.resolve(new Response(res.body, { status: res.status }));
  }) as typeof fetch;
  (impl as unknown as { calls: { url: string; body: string }[] }).calls = calls;
  return impl;
}

const OK_RESULT = {
  runnerVersion: "test",
  results: [{ jobId: "j1", ok: true, output: { inputDigest: "x" } }],
};
const OK_FRAME = framed([{ tag: 0x01, bytes: [...enc.encode(JSON.stringify(OK_RESULT))] }], 0);

describe("SpritesExecPool", () => {
  it("posts the framed exec request and parses the result", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: OK_FRAME }));
    const pool = new SpritesExecPool({
      gatewayBaseUrl: "https://gw.example/",
      workers: ["caveat-wa"],
      fetch: fetchImpl,
    });
    const results = await pool.runBatch("caveat-wa", [{ jobId: "j1", input: { a: 1 } }]);
    expect(results).toEqual(OK_RESULT.results);
    const call = (fetchImpl as unknown as { calls: { url: string; body: string }[] }).calls[0]!;
    expect(call.url).toContain("/v1/sprites/caveat-wa/exec");
    expect(call.url).toContain("stdin=true");
    expect(JSON.parse(call.body)).toEqual({ jobs: [{ jobId: "j1", input: { a: 1 } }] });
  });

  it("retries once after a transport failure, then succeeds", async () => {
    let attempt = 0;
    const fetchImpl = fakeFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return { status: 200, body: framed([{ tag: 0x02, bytes: [...enc.encode("boom")] }], 1) };
      }
      return { status: 200, body: OK_FRAME };
    });
    const pool = new SpritesExecPool({
      gatewayBaseUrl: "https://gw.example",
      workers: ["caveat-wa"],
      fetch: fetchImpl,
    });
    const results = await pool.runBatch("caveat-wa", []);
    expect(results).toEqual(OK_RESULT.results);
    expect(attempt).toBe(2);
  });

  it("throws WorkerUnavailableError after two failed attempts", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 503, body: new Uint8Array() }));
    const pool = new SpritesExecPool({
      gatewayBaseUrl: "https://gw.example",
      workers: ["caveat-wa"],
      fetch: fetchImpl,
    });
    await expect(pool.runBatch("caveat-wa", [])).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(
      (fetchImpl as unknown as { calls: unknown[] }).calls.length,
    ).toBe(2);
  });

  it("throws WorkerUnavailableError on unparseable stdout", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: framed([{ tag: 0x01, bytes: [...enc.encode("not json")] }], 0),
    }));
    const pool = new SpritesExecPool({
      gatewayBaseUrl: "https://gw.example",
      workers: ["caveat-wa"],
      fetch: fetchImpl,
    });
    await expect(pool.runBatch("caveat-wa", [])).rejects.toBeInstanceOf(WorkerUnavailableError);
  });
});

describe("InProcessPool", () => {
  it("runs jobs in-process and records calls", async () => {
    const pool = new InProcessPool(["caveat-wa", "caveat-wb"]);
    const results = await pool.runBatch("caveat-wa", [
      { jobId: "j1", input: { bogus: true } },
    ]);
    expect(results[0]).toMatchObject({ jobId: "j1", ok: false, code: "invalid_input" });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.worker).toBe("caveat-wa");
  });
});
