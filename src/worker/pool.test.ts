import { describe, expect, it, vi } from "vitest";

import { RUNNER_VERSION } from "../runner/run.ts";
import { SpritesHttpPool, WorkerUnavailableError } from "./pool.ts";
import type { WorkerJobResult } from "./pool.ts";

const RESULTS: WorkerJobResult[] = [
  {
    jobId: "j1",
    ok: true,
    output: {
      runnerVersion: RUNNER_VERSION,
      inputDigest: "in",
      results: {},
      smallestPassingCandidate: null,
      resultDigest: "out",
    },
  },
];

function batchBody(results: unknown = RESULTS): Response {
  return new Response(
    JSON.stringify({ runnerVersion: RUNNER_VERSION, results }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function pool(
  fetchImpl: typeof fetch,
  timeoutMs = 60_000,
  sleeps?: number[],
): SpritesHttpPool {
  return new SpritesHttpPool({
    gateways: { "caveat-wa": "https://gw/a", "caveat-wb": "https://gw/b/" },
    fetch: fetchImpl,
    timeoutMs,
    sleep: (ms) => {
      sleeps?.push(ms);
      return Promise.resolve();
    },
  });
}

const JOBS = [{ jobId: "j1", input: { any: "thing" } }];

describe("SpritesHttpPool", () => {
  it("POSTs {jobs} to the worker's connector gateway as JSON", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return Promise.resolve(batchBody());
    };
    const p = pool(fetchImpl);
    const out = await p.runBatch("caveat-wa", JOBS);
    expect(out).toEqual(RESULTS);
    expect(p.workers).toEqual(["caveat-wa", "caveat-wb"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gw/a/run-batch");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ jobs: JOBS });
    // Trailing slashes in the gateway base are normalized.
    await p.runBatch("caveat-wb", JOBS);
    expect(calls[1]?.url).toBe("https://gw/b/run-batch");
  });

  it("retries once after a transport failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValue(batchBody());
    const p = pool(fetchImpl);
    const out = await p.runBatch("caveat-wa", JOBS);
    expect(out).toEqual(RESULTS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a cold-starting worker with backoff until it answers", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValue(batchBody());
    const sleeps: number[] = [];
    const p = pool(fetchImpl, 60_000, sleeps);
    const out = await p.runBatch("caveat-wa", JOBS);
    expect(out).toEqual(RESULTS);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("treats request timeouts as cold starts (waking sprite hangs the request)", async () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValue(batchBody());
    const sleeps: number[] = [];
    const p = pool(fetchImpl, 60_000, sleeps);
    const out = await p.runBatch("caveat-wa", JOBS);
    expect(out).toEqual(RESULTS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("treats connection errors as cold starts and gives up after ~30s", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("conn refused"));
    const sleeps: number[] = [];
    const p = pool(fetchImpl, 60_000, sleeps);
    await expect(p.runBatch("caveat-wa", JOBS)).rejects.toThrow(
      WorkerUnavailableError,
    );
    // initial attempt + 5 backoff retries
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  it("retries a non-2xx response once, then fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("denied", { status: 403 }));
    const p = pool(fetchImpl);
    await expect(p.runBatch("caveat-wa", JOBS)).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails when the response shape is wrong", async () => {
    const cases: unknown[] = [
      "not json",
      { no_runnerVersion: true, results: [] },
      { runnerVersion: "v", results: [{ jobId: 1, ok: true }] },
      { runnerVersion: "v", results: [{ jobId: "j", ok: "yes" }] },
    ];
    for (const body of cases) {
      const fetchImpl: typeof fetch = () =>
        Promise.resolve(
          body === "not json"
            ? new Response("nope", { status: 200 })
            : new Response(JSON.stringify(body), { status: 200 }),
        );
      const p = pool(fetchImpl);
      await expect(p.runBatch("caveat-wa", JOBS)).rejects.toThrow(
        WorkerUnavailableError,
      );
    }
  });

  it("aborts a hung worker at the timeout and fails after the retry", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const p = pool(fetchImpl, 10);
    await expect(p.runBatch("caveat-wa", JOBS)).rejects.toThrow(
      WorkerUnavailableError,
    );
  });

  it("fails fast for a worker with no connector configured", async () => {
    const p = pool(() => Promise.reject(new Error("should not fetch")));
    await expect(p.runBatch("caveat-ghost", JOBS)).rejects.toThrow(/no connector/);
  });
});
