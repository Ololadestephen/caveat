import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type RunStatus =
  | "running"
  | "reviewable"
  | "needs_review"
  | "failed"
  | "approved"
  | "stale";

export type ExportResult = "exported" | "blocked_stale" | "blocked_unavailable";

export type RunRow = {
  id: string;
  created_at: string;
  status: RunStatus;
  status_reason: string | null;
  source_tuple_json: string;
  receipt_json: string;
  receipt_hash: string;
  draft_text: string;
  draft_hash: string;
  superseded_by: string | null;
  stale_detail_json: string | null;
};

export type ApprovalRow = {
  id: string;
  run_id: string;
  receipt_hash: string;
  draft_hash: string;
  approved_by: string;
  approved_at: string;
};

export type ExportRow = {
  id: string;
  run_id: string;
  approval_id: string;
  at: string;
  result: ExportResult;
  detail_json: string | null;
  draft_hash: string;
};

const SCHEMA_VERSION = 2;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    source_tuple_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    draft_hash TEXT NOT NULL,
    superseded_by TEXT,
    stale_detail_json TEXT
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    receipt_hash TEXT NOT NULL,
    draft_hash TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );
  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    at TEXT NOT NULL,
    result TEXT NOT NULL CHECK(result IN ('exported','blocked_stale','blocked_unavailable')),
    detail_json TEXT,
    draft_hash TEXT NOT NULL
  );
  -- The receipt and the draft derived from it are immutable once a run has
  -- finished: approvals bind to these exact hashes, so they can never be
  -- edited later. A row still "running" keeps its placeholders until the
  -- pipeline writes the real receipt.
  CREATE TRIGGER runs_immutable
    BEFORE UPDATE OF receipt_json, receipt_hash, draft_text, draft_hash ON runs
    WHEN OLD.status <> 'running'
    BEGIN
      SELECT RAISE(ABORT, 'runs receipt fields are immutable');
    END;
  `,
  // A finished run can never return to "running", which would reopen its
  // receipt fields to writes.
  `
  CREATE TRIGGER runs_no_reopen
    BEFORE UPDATE OF status ON runs
    WHEN NEW.status = 'running' AND OLD.status <> 'running'
    BEGIN
      SELECT RAISE(ABORT, 'a finished run cannot return to running');
    END;
  `,
];

export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function newRowId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

// Opens (creating and migrating as needed) the store. A run left "running"
// when the process last stopped is a visible failure, not silently resumed.
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const versionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  let version = versionRow?.user_version ?? 0;
  while (version < SCHEMA_VERSION) {
    db.exec(MIGRATIONS[version]!);
    version += 1;
    db.exec(`PRAGMA user_version = ${version}`);
  }
  db.prepare(
    "UPDATE runs SET status = 'failed', status_reason = 'interrupted' WHERE status = 'running'",
  ).run();
  return db;
}

export function createRun(
  db: DatabaseSync,
  run: {
    id: string;
    createdAt: string;
    sourceTupleJson: string;
    receiptJson: string;
    receiptHash: string;
    draftText: string;
    draftHash: string;
  },
): void {
  db.prepare(
    `INSERT INTO runs (id, created_at, status, status_reason, source_tuple_json,
       receipt_json, receipt_hash, draft_text, draft_hash, superseded_by, stale_detail_json)
     VALUES (?, ?, 'running', NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    run.id,
    run.createdAt,
    run.sourceTupleJson,
    run.receiptJson,
    run.receiptHash,
    run.draftText,
    run.draftHash,
  );
}

export function getRun(db: DatabaseSync, id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function listRuns(db: DatabaseSync): RunRow[] {
  return db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC, id DESC")
    .all() as unknown as RunRow[];
}

export function finishRun(
  db: DatabaseSync,
  id: string,
  status: "reviewable" | "needs_review" | "failed",
  statusReason: string | null,
  fields?: {
    sourceTupleJson?: string;
    receiptJson?: string;
    receiptHash?: string;
    draftText?: string;
    draftHash?: string;
  },
): void {
  if (fields === undefined) {
    db.prepare("UPDATE runs SET status = ?, status_reason = ? WHERE id = ?").run(
      status,
      statusReason,
      id,
    );
    return;
  }
  db.prepare(
    `UPDATE runs SET status = ?, status_reason = ?,
       source_tuple_json = COALESCE(?, source_tuple_json),
       receipt_json = COALESCE(?, receipt_json),
       receipt_hash = COALESCE(?, receipt_hash),
       draft_text = COALESCE(?, draft_text),
       draft_hash = COALESCE(?, draft_hash)
     WHERE id = ?`,
  ).run(
    status,
    statusReason,
    fields.sourceTupleJson ?? null,
    fields.receiptJson ?? null,
    fields.receiptHash ?? null,
    fields.draftText ?? null,
    fields.draftHash ?? null,
    id,
  );
}

// Every earlier run is superseded once a newer run exists — the reviewer must
// always look at the latest evidence.
export function supersedeOthers(db: DatabaseSync, newRunId: string): void {
  db.prepare(
    "UPDATE runs SET superseded_by = ? WHERE id != ? AND superseded_by IS NULL",
  ).run(newRunId, newRunId);
}

export function getApproval(db: DatabaseSync, runId: string): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE run_id = ?").get(runId) as
    | ApprovalRow
    | undefined;
}

export type ApproveOutcome =
  | { ok: true; approval: ApprovalRow; created: boolean }
  | { ok: false; error: "not_found" | "wrong_status" | "hash_mismatch"; status?: string };

export function approveRun(
  db: DatabaseSync,
  runId: string,
  receiptHash: string,
  draftHash: string,
  approvedBy: string,
  approvedAt: string,
): ApproveOutcome {
  const run = getRun(db, runId);
  if (run === undefined) return { ok: false, error: "not_found" };
  if (run.receipt_hash !== receiptHash || run.draft_hash !== draftHash) {
    return { ok: false, error: "hash_mismatch" };
  }
  const existing = getApproval(db, runId);
  if (existing !== undefined) {
    return { ok: true, approval: existing, created: false };
  }
  if (run.status !== "reviewable") {
    return { ok: false, error: "wrong_status", status: run.status };
  }
  const id = newRowId("appr");
  db.prepare(
    `INSERT INTO approvals (id, run_id, receipt_hash, draft_hash, approved_by, approved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, runId, receiptHash, draftHash, approvedBy, approvedAt);
  db.prepare("UPDATE runs SET status = 'approved' WHERE id = ?").run(runId);
  return {
    ok: true,
    approval: {
      id,
      run_id: runId,
      receipt_hash: receiptHash,
      draft_hash: draftHash,
      approved_by: approvedBy,
      approved_at: approvedAt,
    },
    created: true,
  };
}

export function markStale(db: DatabaseSync, runId: string, staleDetailJson: string): void {
  db.prepare("UPDATE runs SET status = 'stale', stale_detail_json = ? WHERE id = ?").run(
    staleDetailJson,
    runId,
  );
}

export function recordExport(
  db: DatabaseSync,
  row: {
    runId: string;
    approvalId: string;
    at: string;
    result: ExportResult;
    detailJson: string | null;
    draftHash: string;
  },
): string {
  const id = newRowId("exp");
  db.prepare(
    `INSERT INTO exports (id, run_id, approval_id, at, result, detail_json, draft_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, row.runId, row.approvalId, row.at, row.result, row.detailJson, row.draftHash);
  return id;
}

export function listExports(db: DatabaseSync, runId: string): ExportRow[] {
  return db
    .prepare("SELECT * FROM exports WHERE run_id = ? ORDER BY at, id")
    .all(runId) as unknown as ExportRow[];
}
