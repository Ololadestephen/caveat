import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approveRun,
  createRun,
  finishRun,
  getApproval,
  getRun,
  listExports,
  listRuns,
  markStale,
  newRunId,
  openDb,
  recordExport,
  supersedeOthers,
} from "./db.ts";

function seedRun(db: ReturnType<typeof openDb>, id: string): void {
  createRun(db, {
    id,
    createdAt: "2026-11-24T12:00:00Z",
    sourceTupleJson: "[]",
    receiptJson: "{}",
    receiptHash: "rhash",
    draftText: "draft",
    draftHash: "dhash",
  });
}

describe("run lifecycle", () => {
  it("creates a running row and finishes it", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    expect(getRun(db, "run-1")?.status).toBe("running");
    finishRun(db, "run-1", "reviewable", null);
    expect(getRun(db, "run-1")?.status).toBe("reviewable");
    finishRun(db, "run-1", "needs_review", "ambiguous");
    expect(getRun(db, "run-1")?.status_reason).toBe("ambiguous");
  });

  it("marks every other run superseded by the newest", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-old");
    seedRun(db, "run-new");
    supersedeOthers(db, "run-new");
    expect(getRun(db, "run-old")?.superseded_by).toBe("run-new");
    expect(getRun(db, "run-new")?.superseded_by).toBeNull();
    // A still-newer run re-points every earlier run at itself.
    seedRun(db, "run-newest");
    supersedeOthers(db, "run-newest");
    expect(getRun(db, "run-old")?.superseded_by).toBe("run-newest");
    expect(getRun(db, "run-new")?.superseded_by).toBe("run-newest");
  });

  it("lists runs newest first", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-a");
    seedRun(db, "run-b");
    expect(listRuns(db).map((r) => r.id)).toEqual(["run-b", "run-a"]);
  });
});

describe("approveRun", () => {
  it("approves a reviewable run exactly once", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    finishRun(db, "run-1", "reviewable", null);
    const first = approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "dhash", approvedBy: "Ololade Stephen", approvedAt: "t" });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(getRun(db, "run-1")?.status).toBe("approved");

    const again = approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "dhash", approvedBy: "Ololade Stephen", approvedAt: "t2" });
    expect(again).toMatchObject({ ok: true, created: false });
    if (again.ok && first.ok) {
      expect(again.approval.id).toBe(first.approval.id);
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n,
    ).toBe(1);
  });

  it("rejects a tampered hash without writing anything", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    finishRun(db, "run-1", "reviewable", null);
    const out = approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "WRONG", approvedBy: "Ololade Stephen", approvedAt: "t" });
    expect(out).toMatchObject({ ok: false, error: "hash_mismatch" });
    expect(getApproval(db, "run-1")).toBeUndefined();
    expect(getRun(db, "run-1")?.status).toBe("reviewable");
  });

  it("rejects runs that are not reviewable", () => {
    const db = openDb(":memory:");
    for (const status of ["needs_review", "failed", "stale"] as const) {
      seedRun(db, `run-${status}`);
      finishRun(db, `run-${status}`, status === "stale" ? "reviewable" : status, null);
      if (status === "stale") markStale(db, `run-${status}`, "{}");
      const out = approveRun(db, { runId: `run-${status}`, receiptHash: "rhash", draftHash: "dhash", approvedBy: "X", approvedAt: "t" });
      expect(out).toMatchObject({ ok: false, error: "wrong_status" });
    }
  });

  it("refuses a fresh approval after an approved run went stale", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    finishRun(db, "run-1", "reviewable", null);
    approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "dhash", approvedBy: "X", approvedAt: "t" });
    markStale(db, "run-1", "[{\"kind\":\"version_changed\"}]");
    const out = approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "dhash", approvedBy: "X", approvedAt: "t2" });
    expect(out).toMatchObject({ ok: false, error: "wrong_status", status: "stale" });
    expect(getApproval(db, "run-1")?.approved_at).toBe("t");
  });

  it("returns not_found for a missing run", () => {
    const db = openDb(":memory:");
    expect(approveRun(db, { runId: "nope", receiptHash: "r", draftHash: "d", approvedBy: "X", approvedAt: "t" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

describe("exports and staleness", () => {
  it("records export attempts and marks a run stale with detail", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    finishRun(db, "run-1", "reviewable", null);
    approveRun(db, { runId: "run-1", receiptHash: "rhash", draftHash: "dhash", approvedBy: "X", approvedAt: "t" });
    const approval = getApproval(db, "run-1")!;
    recordExport(db, {
      runId: "run-1",
      approvalId: approval.id,
      at: "t1",
      result: "blocked_stale",
      detailJson: "[{\"kind\":\"version_changed\"}]",
      draftHash: "dhash",
    });
    markStale(db, "run-1", "[{\"kind\":\"version_changed\"}]");
    expect(getRun(db, "run-1")?.status).toBe("stale");
    expect(getRun(db, "run-1")?.stale_detail_json).toContain("version_changed");
    expect(listExports(db, "run-1")).toHaveLength(1);
    expect(listExports(db, "run-1")[0]?.result).toBe("blocked_stale");
  });
});

describe("durability invariants", () => {
  it("aborts updates of receipt or draft fields once a run has finished", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    // A still-running row may still be written (the pipeline owns it).
    finishRun(db, "run-1", "reviewable", null, { receiptJson: "{\"real\":true}" });
    for (const col of ["receipt_json", "receipt_hash", "draft_text", "draft_hash"]) {
      expect(() =>
        db.prepare(`UPDATE runs SET ${col} = 'x' WHERE id = 'run-1'`).run(),
      ).toThrow(/immutable/);
    }
    expect(getRun(db, "run-1")?.receipt_json).toBe("{\"real\":true}");
    // Other fields remain mutable.
    expect(getRun(db, "run-1")?.status).toBe("reviewable");
  });

  it("refuses to move a finished run back to running", () => {
    const db = openDb(":memory:");
    seedRun(db, "run-1");
    finishRun(db, "run-1", "reviewable", null, { receiptJson: "{\"real\":true}" });
    expect(() =>
      db.prepare("UPDATE runs SET status = 'running' WHERE id = 'run-1'").run(),
    ).toThrow(/cannot return to running/);
    expect(getRun(db, "run-1")?.status).toBe("reviewable");
  });

  it("marks an interrupted run failed on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "caveat-db-"));
    try {
      const path = join(dir, "caveat.db");
      const db1 = openDb(path);
      seedRun(db1, "run-1");
      db1.close();
      const db2 = openDb(path);
      const run = getRun(db2, "run-1");
      expect(run?.status).toBe("failed");
      expect(run?.status_reason).toBe("interrupted");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("newRunId", () => {
  it("has the run-YYYYMMDD-HHMMSS-xxxx shape", () => {
    expect(newRunId(new Date("2026-11-24T13:45:06Z"))).toMatch(/^run-20261124-134506-[0-9a-f]{4}$/);
  });
});
