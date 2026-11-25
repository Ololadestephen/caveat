import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { RUNNER_VERSION } from "../runner/run.ts";
import { createWorkerServer } from "./server.ts";

let server: Server | undefined;
let origin = "";

async function listen(): Promise<void> {
  server = createWorkerServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
});

const FIXTURE = JSON.parse(
  readFileSync("fixtures/runner/synthetic-12k.json", "utf8"),
) as unknown;

describe("worker server", () => {
  it("answers GET /healthz with ok", async () => {
    await listen();
    const res = await fetch(`${origin}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("runs a valid batch and returns one result per job", async () => {
    await listen();
    const res = await fetch(`${origin}/run-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobs: [
          { jobId: "a", input: FIXTURE },
          { jobId: "b", input: { bogus: true } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runnerVersion: string;
      results: { jobId: string; ok: boolean; code?: string }[];
    };
    expect(body.runnerVersion).toBe(RUNNER_VERSION);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ jobId: "a", ok: true });
    expect(body.results[1]).toMatchObject({
      jobId: "b",
      ok: false,
      code: "invalid_input",
    });
  });

  it("rejects invalid JSON and the wrong shape with 400", async () => {
    await listen();
    for (const body of ["not json", '{"jobs":{}}', '{"jobs":[{"jobId":1}]}']) {
      const res = await fetch(`${origin}/run-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    }
  });

  it("rejects an oversized body with 413", async () => {
    await listen();
    const res = await fetch(`${origin}/run-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobs: [{ jobId: "x", input: "x".repeat(1_100_000) }] }),
    });
    expect(res.status).toBe(413);
  });

  it("answers 404 for anything else", async () => {
    await listen();
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/run-batch`)).status).toBe(404);
    const res = await fetch(`${origin}/exec`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
