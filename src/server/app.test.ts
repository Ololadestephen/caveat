import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { RecheckOutcome, SourceTuple, StaleChange } from "../evidence/recheck.ts";
import type { Connection } from "../gateway.ts";
import { fixtureReceipt } from "../review/fixture-receipt.ts";
import { draftHash, receiptHash } from "../review/draft.ts";
import type { RunReceipt } from "../review/receipt.ts";
import { canonicalJson } from "../runner/digest.ts";
import { createRun, getRun, markStale, openDb } from "../store/db.ts";
import { createApp } from "./app.ts";
import type { AppDeps } from "./app.ts";

const TUPLE: SourceTuple = [
  {
    fileName: "01-consulting-agreement.pdf",
    fileId: "f1",
    versionId: "v1",
    sha256: "1".repeat(64),
    size: 10,
  },
  {
    fileName: "02-first-amendment.pdf",
    fileId: "f2",
    versionId: "v2",
    sha256: "2".repeat(64),
    size: 10,
  },
  {
    fileName: "03-second-amendment.pdf",
    fileId: "f3",
    versionId: "v3",
    sha256: "3".repeat(64),
    size: 10,
  },
];

const BOX: Connection[] = [{ provider: "box", gatewayBaseUrl: "https://gateway.test/box" }];

type Rig = {
  db: DatabaseSync;
  server: Server;
  origin: string;
  recheckState: { outcome: RecheckOutcome | Error };
  pipelineOutcome: { receipt: (runId: string) => RunReceipt; fail?: string };
  pipelineConfigs: {
    previous?: { runId: string };
    carrySources?: { runId: string }[];
    contract?: string;
  }[];
};

const running: Rig[] = [];

async function rig(overrides: Partial<AppDeps> = {}): Promise<Rig> {
  const db = openDb(":memory:");
  const recheckState: Rig["recheckState"] = { outcome: { ok: true, tuple: TUPLE, changes: [] } };
  const pipelineOutcome: Rig["pipelineOutcome"] = { receipt: fixtureReceipt };
  const pipelineConfigs: Rig["pipelineConfigs"] = [];
  const server = createApp({
    db,
    approver: "Ololade Stephen",
    revision: "testrev123",
    reviewsDir: "reviews",
    fixturesDir: "fixtures",
    boxFolder: "caveat_TEST",
    decisionModel: undefined,
    runTimeoutMs: 5000,
    recheckTimeoutMs: 5000,
    holdTask: () => ({ stop: () => {} }),
    connections: () => Promise.resolve(BOX),
    recheck: () => {
      if (recheckState.outcome instanceof Error) {
        return Promise.reject(recheckState.outcome);
      }
      return Promise.resolve(recheckState.outcome);
    },
    pipeline: (config) => {
      pipelineConfigs.push(config);
      if (pipelineOutcome.fail !== undefined) {
        return Promise.reject(new Error(pipelineOutcome.fail));
      }
      return Promise.resolve({
        receipt: pipelineOutcome.receipt(config.runId),
        sourceTuple: TUPLE,
      });
    },
    ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const r = { db, server, origin: `http://127.0.0.1:${address.port}`, recheckState, pipelineOutcome, pipelineConfigs };
  running.push(r);
  return r;
}

afterEach(() => {
  for (const r of running.splice(0)) {
    r.server.close();
    r.db.close();
  }
});

function post(r: Rig, path: string, body = "", origin: string | undefined = r.origin) {
  return fetch(`${r.origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...(origin !== undefined ? { origin } : {}),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

async function waitForRun(db: DatabaseSync, runId: string, want = /^(reviewable|needs_review|failed|stale|approved)$/) {
  for (let i = 0; i < 200; i += 1) {
    const run = getRun(db, runId);
    if (run !== undefined && want.test(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never finished`);
}

async function startRun(r: Rig): Promise<string> {
  const res = await post(r, "/runs");
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  const runId = location.replace("/runs/", "");
  await waitForRun(r.db, runId);
  return runId;
}

async function startApprovedRun(r: Rig): Promise<{ runId: string; receipt: RunReceipt }> {
  const runId = await startRun(r);
  const run = getRun(r.db, runId)!;
  const res = await post(
    r,
    `/runs/${runId}/approve`,
    `receiptHash=${run.receipt_hash}&draftHash=${run.draft_hash}`,
  );
  expect(res.status).toBe(303);
  const receipt = JSON.parse(run.receipt_json) as RunReceipt;
  return { runId, receipt };
}

describe("caveat app", () => {
  it("serves healthz, the run list and the app css", async () => {
    const r = await rig();
    expect(await (await fetch(`${r.origin}/healthz`)).text()).toBe("ok");
    const home = await fetch(`${r.origin}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    expect(home.headers.get("referrer-policy")).toBe("no-referrer");
    const css = await fetch(`${r.origin}/app.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("refuses a manual start with 409 while a run is in flight", async () => {
    const r = await rig({
      pipeline: () => new Promise(() => {}), // the run never finishes
    });
    const first = await post(r, "/runs");
    expect(first.status).toBe(303);
    const second = await post(r, "/runs");
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("already in progress");
  });

  it("starts a run for the named contract and rejects unknown ones", async () => {
    const r = await rig();
    expect((await post(r, "/runs", "contract=bogus")).status).toBe(400);
    const res = await post(r, "/runs", "contract=aviat");
    expect(res.status).toBe(303);
    const runId = res.headers.get("location")!.replace("/runs/", "");
    const run = await waitForRun(r.db, runId);
    expect(run.contract).toBe("aviat");
    // The pipeline sees the contract so dispatch can pick the path.
    expect(r.pipelineConfigs.at(-1)?.contract).toBe("aviat");
  });

  it("defaults a bare POST to the twinvee contract", async () => {
    const r = await rig();
    const runId = await startRun(r);
    expect(getRun(r.db, runId)?.contract).toBe("twinvee");
  });

  it("rejects POSTs without a matching Origin", async () => {
    const r = await rig();
    // fetch always sends Origin on POST; a bare socket exercises the absent case.
    const bare = await new Promise<number>((resolve, reject) => {
      const req = request(`${r.origin}/runs`, { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    expect(bare).toBe(403);
    expect((await post(r, "/runs", "", "https://evil.example")).status).toBe(403);
  });

  it("runs the pipeline and renders the reviewable run", async () => {
    const r = await rig();
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    expect(run.status).toBe("reviewable");
    const page = await (await fetch(`${r.origin}/runs/${runId}`)).text();
    expect(page).toContain("Escrow release");
    expect(page).toContain("from December 31, 2026 until March 31, 2026");
    expect(page).toContain("weekend");
    expect(page).toContain("Approve this receipt");
    expect(page).toContain("testrev123");
    expect(page).not.toContain("Export draft");
  });

  it("runs to needs_review when the pipeline blocks", async () => {
    const r = await rig();
    r.pipelineOutcome.receipt = (runId) => ({
      ...fixtureReceipt(runId),
      status: "needs_review",
      blockedReasons: [{ reason: "quote_not_verbatim", detail: "quote not found" }],
      effectiveAction: "needs_review",
    });
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    expect(run.status).toBe("needs_review");
    expect(run.status_reason).toContain("quote_not_verbatim");
    const res = await post(r, `/runs/${runId}/approve`, `receiptHash=${run.receipt_hash}&draftHash=${run.draft_hash}`);
    expect(res.status).toBe(409);
    expect((await post(r, `/runs/${runId}/export`)).status).toBe(409);
  });

  it("marks pipeline failures as failed and refuses approve/export", async () => {
    const r = await rig();
    r.pipelineOutcome.fail = "box gateway 502";
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    expect(run.status).toBe("failed");
    expect(run.status_reason).toContain("box gateway 502");
    expect((await post(r, `/runs/${runId}/approve`, `receiptHash=x&draftHash=y`)).status).toBe(409);
    expect((await post(r, `/runs/${runId}/export`)).status).toBe(409);
  });

  it("fails a run that outlives the run timeout", async () => {
    const db = openDb(":memory:");
    const server = createApp({
      db,
      approver: "a",
      revision: "r",
      reviewsDir: "x",
      fixturesDir: "x",
      boxFolder: "f",
      decisionModel: undefined,
      runTimeoutMs: 40,
      recheckTimeoutMs: 5000,
      holdTask: () => ({ stop: () => {} }),
      pipeline: () => new Promise(() => {}),
      connections: () => Promise.resolve(BOX),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    running.push({ db, server, origin: "", recheckState: { outcome: { ok: true, tuple: [], changes: [] } }, pipelineOutcome: { receipt: fixtureReceipt }, pipelineConfigs: [] });
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    const runId = res.headers.get("location")!.replace("/runs/", "");
    const run = await waitForRun(db, runId, /^failed$/);
    expect(run.status_reason).toBe("timeout");
  });

  it("rejects a tampered hash with 409 and writes nothing", async () => {
    const r = await rig();
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    const res = await post(r, `/runs/${runId}/approve`, `receiptHash=${run.receipt_hash}&draftHash=deadbeef`);
    expect(res.status).toBe(409);
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(getRun(r.db, runId)!.status).toBe("reviewable");
  });

  it("approves once and is idempotent on repeat", async () => {
    const r = await rig();
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    const body = `receiptHash=${run.receipt_hash}&draftHash=${run.draft_hash}`;
    expect((await post(r, `/runs/${runId}/approve`, body)).status).toBe(303);
    const first = r.db.prepare("SELECT id FROM approvals").get() as { id: string };
    expect((await post(r, `/runs/${runId}/approve`, body)).status).toBe(303);
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 1 });
    expect(r.db.prepare("SELECT id FROM approvals").get()).toEqual(first);
    const page = await (await fetch(`${r.origin}/runs/${runId}`)).text();
    expect(page).toContain("Approved by Ololade Stephen");
    expect(page).toContain("Export draft");
  });

  it("exports the exact draft bytes for an approved run", async () => {
    const r = await rig();
    const { runId, receipt } = await startApprovedRun(r);
    const res = await post(r, `/runs/${runId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="caveat-draft-${runId}-v1.txt"`,
    );
    const body = await res.text();
    const run = getRun(r.db, runId)!;
    expect(body).toBe(run.draft_text);
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(run.draft_hash);
    expect(run.draft_hash).toBe(draftHash(body));
    expect(run.receipt_hash).toBe(receiptHash(receipt));
    expect(canonicalJson(receipt)).toBe(run.receipt_json);
    const exports = r.db.prepare("SELECT * FROM exports").all() as { result: string }[];
    expect(exports.map((e) => e.result)).toEqual(["exported"]);
  });

  it.each([
    {
      kind: "added",
      change: { fileName: "04-new.pdf", kind: "added", newVersionTag: "t", newSha12: "s" },
    },
    {
      kind: "removed",
      change: { fileName: "01-consulting-agreement.pdf", kind: "removed", oldVersionTag: "t", oldSha12: "s" },
    },
    {
      kind: "version_changed",
      change: {
        fileName: "03-second-amendment.pdf",
        kind: "version_changed",
        oldVersionTag: "a",
        newVersionTag: "b",
        oldSha12: "3".repeat(12),
        newSha12: "3".repeat(12),
      },
    },
    {
      kind: "content_changed",
      change: {
        fileName: "03-second-amendment.pdf",
        kind: "content_changed",
        oldVersionTag: "a",
        newVersionTag: "a",
        oldSha12: "old",
        newSha12: "new",
      },
    },
  ] as { kind: string; change: StaleChange }[])(
    "marks the run stale and blocks export with 409 for kind=$kind",
    async ({ change }) => {
      const r = await rig();
      const { runId } = await startApprovedRun(r);
      r.recheckState.outcome = { ok: true, tuple: TUPLE, changes: [change] };
      const res = await post(r, `/runs/${runId}/export`);
      expect(res.status).toBe(409);
      const run = getRun(r.db, runId)!;
      expect(run.status).toBe("stale");
      const detail = JSON.parse(run.stale_detail_json!) as StaleChange[];
      expect(detail).toEqual([change]);
      const exports = r.db.prepare("SELECT result FROM exports").all() as { result: string }[];
      expect(exports).toEqual([{ result: "blocked_stale" }]);
      const page = await (await fetch(`${r.origin}/runs/${runId}`)).text();
      expect(page).toContain(change.kind);
    },
  );

  it("blocks export of a watcher-staled run and records each attempt", async () => {
    const r = await rig();
    const { runId } = await startApprovedRun(r);
    const changes: StaleChange[] = [
      {
        fileName: "03-second-amendment.pdf",
        kind: "version_changed",
        oldVersionTag: "99400d6f8bd6",
        newVersionTag: "5ae8e602aa7f",
        oldSha12: "3".repeat(12),
        newSha12: "3".repeat(12),
      },
    ];
    markStale(r.db, runId, JSON.stringify(changes));
    const res = await post(r, `/runs/${runId}/export`);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("The source files changed since approval");
    expect(body).toContain("03-second-amendment.pdf");
    expect(body).toContain("99400d6f8bd6");
    expect(body).toContain("5ae8e602aa7f");
    const exports = r.db.prepare("SELECT result, detail_json FROM exports").all() as {
      result: string;
      detail_json: string;
    }[];
    expect(exports).toEqual([{ result: "blocked_stale", detail_json: JSON.stringify(changes) }]);
    const second = await post(r, `/runs/${runId}/export`);
    expect(second.status).toBe(409);
    expect(r.db.prepare("SELECT result FROM exports").all()).toEqual([
      { result: "blocked_stale" },
      { result: "blocked_stale" },
    ]);
  });

  it.each([
    ["gateway 403", { ok: false, detail: "403 from gateway" } satisfies RecheckOutcome],
    ["recheck threw", new Error("network down")],
  ])("returns 503 and keeps the run approved on %s", async (_label, outcome) => {
    const r = await rig();
    const { runId } = await startApprovedRun(r);
    r.recheckState.outcome = outcome;
    const res = await post(r, `/runs/${runId}/export`);
    expect(res.status).toBe(503);
    const run = getRun(r.db, runId)!;
    expect(run.status).toBe("approved");
    const exports = r.db.prepare("SELECT result FROM exports").all() as { result: string }[];
    expect(exports).toEqual([{ result: "blocked_unavailable" }]);
  });

  it("supersedes earlier runs when a newer run completes", async () => {
    const r = await rig();
    const first = await startRun(r);
    const second = await startRun(r);
    const row = getRun(r.db, first)!;
    expect(row.superseded_by).toBe(second);
    const page = await (await fetch(`${r.origin}/runs/${first}`)).text();
    expect(page).toContain("Superseded");
    const list = await (await fetch(`${r.origin}/`)).text();
    expect(list).toContain("superseded");
  });

  it("404s unknown runs and keeps a running run unfinished", async () => {
    const r = await rig();
    expect((await fetch(`${r.origin}/runs/run-nope`)).status).toBe(404);
    expect((await post(r, "/runs/run-nope/approve", "receiptHash=x&draftHash=y")).status).toBe(404);
    expect((await post(r, "/runs/run-nope/export")).status).toBe(404);
  });

  it("requires the approver to be configured", async () => {
    const r = await rig({ approver: undefined });
    const runId = await startRun(r);
    const run = getRun(r.db, runId)!;
    const res = await post(r, `/runs/${runId}/approve`, `receiptHash=${run.receipt_hash}&draftHash=${run.draft_hash}`);
    expect(res.status).toBe(503);
  });
});

describe("manual run baseline", () => {
  it("passes the newest reviewable-with-digests run as previous, skipping blocked runs", async () => {
    const r = await rig();
    const seed = (id: string, createdAt: string, status: string, receipt: object) => {
      createRun(r.db, {
        id,
        createdAt,
        sourceTupleJson: JSON.stringify(TUPLE),
        receiptJson: JSON.stringify(receipt),
        receiptHash: "",
        draftText: "",
        draftHash: "",
      });
      r.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
    };
    const goodReceipt = {
      ...fixtureReceipt("run-good"),
      status: "reviewable",
      sectionDigests: { "a#b": "x" },
      typedCallDigests: { release_timing: "d" },
    };
    seed("run-good", "2026-11-25T01:00:00.000Z", "approved", goodReceipt);
    seed("run-blocked", "2026-11-25T02:00:00.000Z", "needs_review", {
      ...goodReceipt,
      runId: "run-blocked",
      status: "needs_review",
    });

    const runId = await startRun(r);
    expect(runId).toBeTruthy();
    const config = r.pipelineConfigs.find((c) => (c as { runId?: string }).runId === runId);
    expect((config?.previous as { runId?: string } | undefined)?.runId).toBe("run-good");
    // needs_review receipts join the pool so a review file can name them via
    // extractedIn; the pipeline still only carries calls from reviewable ones.
    expect(config?.carrySources?.map((s) => s.runId)).toEqual(["run-blocked", "run-good"]);
  });
});
