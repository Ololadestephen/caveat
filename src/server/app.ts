import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { recheckFolder } from "../evidence/recheck.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { listConnections } from "../gateway.ts";
import type { Connection } from "../gateway.ts";
import { runPipeline } from "../pipeline/run-pipeline.ts";
import type { PipelineConfig } from "../pipeline/run-pipeline.ts";
import { escapeHtml } from "../review/decision-card.ts";
import { draftHash, receiptHash, renderDraft } from "../review/draft.ts";
import type { RunReceipt } from "../review/receipt.ts";
import { REVIEW_PAGE_CSS } from "../review/review-page.ts";
import { canonicalJson } from "../runner/digest.ts";
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
  recordExport,
  supersedeOthers,
} from "../store/db.ts";
import { pageShell, renderRun, renderRunList } from "./pages.ts";
import { startTaskHold } from "./task-hold.ts";

const APP_CSS = `${REVIEW_PAGE_CSS}
nav{margin-bottom:1rem;font-size:.9rem}nav a{color:#36c}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.8rem;font-weight:600}
.badge--running{background:#e6f0ff}.badge--reviewable{background:#eaf6ea}
.badge--needs_review{background:#fdeaea}.badge--failed{background:#f0d0d0}
.badge--approved{background:#d8eed8}.badge--stale{background:#fff0d0}
.badge--superseded{background:#eee;color:#555}
pre.draft{background:#f7f7f7;border:1px solid #ddd;padding:.8rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap}
form{display:inline-block}button{padding:.4rem .9rem;font-size:.9rem}
footer{margin-top:2rem;padding-top:.5rem;border-top:1px solid #ddd;color:#666;font-size:.8rem}
table.runs td,table.runs th{padding:.4rem .6rem}`;

export type AppDeps = {
  db: DatabaseSync;
  approver: string | undefined;
  revision: string;
  reviewsDir: string;
  fixturesDir: string;
  boxFolder: string;
  decisionModel: string | undefined;
  runTimeoutMs: number;
  recheckTimeoutMs: number;
  pipeline?: (config: PipelineConfig) => Promise<{
    receipt: RunReceipt;
    sourceTuple: SourceTuple;
  }>;
  connections?: () => Promise<Connection[]>;
  recheck?: typeof recheckFolder;
  holdTask?: (name: string) => { stop: () => void };
};

type Ctx = {
  db: DatabaseSync;
  deps: AppDeps;
  pipeline: NonNullable<AppDeps["pipeline"]>;
  connections: NonNullable<AppDeps["connections"]>;
  recheck: NonNullable<AppDeps["recheck"]>;
  holdTask: NonNullable<AppDeps["holdTask"]>;
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, ...SECURITY_HEADERS });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// POSTs must come from the same origin: Origin (or Referer) must match Host.
function sameOrigin(req: IncomingMessage): boolean {
  const source = req.headers.origin ?? req.headers.referer;
  const host = req.headers.host;
  if (source === undefined || host === undefined) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

function kickRun(ctx: Ctx, runId: string): void {
  const { db, deps, pipeline, holdTask } = ctx;
  const hold = holdTask(`caveat-run-${runId}`);
  let settled = false;
  const finish = (
    status: "reviewable" | "needs_review" | "failed",
    reason: string | null,
    fields?: Parameters<typeof finishRun>[4],
  ) => {
    if (settled) return;
    settled = true;
    try {
      const run = getRun(db, runId);
      if (run === undefined || run.status !== "running") return;
      finishRun(db, runId, status, reason, fields);
      if (status === "reviewable" || status === "needs_review") supersedeOthers(db, runId);
    } finally {
      hold.stop();
    }
  };
  const work = (async () => {
    const { receipt, sourceTuple } = await pipeline({
      runId,
      reviewsDir: deps.reviewsDir,
      fixturesDir: deps.fixturesDir,
      boxFolder: deps.boxFolder,
      ...(deps.decisionModel !== undefined ? { decisionModel: deps.decisionModel } : {}),
    });
    const draft = renderDraft(receipt);
    finish(receipt.status === "reviewable" ? "reviewable" : "needs_review",
      receipt.status === "needs_review"
        ? receipt.blockedReasons.map((r) => r.reason).join("; ") || "needs_review"
        : null,
      {
        sourceTupleJson: JSON.stringify(sourceTuple),
        receiptJson: canonicalJson(receipt),
        receiptHash: receiptHash(receipt),
        draftText: draft,
        draftHash: draftHash(draft),
      });
  })();
  work.catch((error: unknown) => {
    finish("failed", error instanceof Error ? error.message.slice(0, 300) : "unknown error");
  });
  setTimeout(() => finish("failed", "timeout"), deps.runTimeoutMs).unref();
}

async function handleApprove(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const { db, deps } = ctx;
  const run = getRun(db, runId);
  if (run === undefined) return html(res, 404, pageShell("Not found", deps.revision, "<h1>Not found</h1>"));
  if (deps.approver === undefined) {
    return html(res, 503, pageShell("Approver not configured", deps.revision, "<h1>Approver not configured</h1>"));
  }
  const body = new URLSearchParams(await readBody(req));
  const rHash = body.get("receiptHash") ?? "";
  const dHash = body.get("draftHash") ?? "";
  const outcome = approveRun(
    db,
    runId,
    rHash,
    dHash,
    deps.approver,
    new Date().toISOString(),
  );
  if (!outcome.ok) {
    const status = outcome.error === "not_found" ? 404 : 409;
    const detail =
      outcome.error === "hash_mismatch"
        ? "the submitted hashes do not match this run's receipt"
        : outcome.error === "wrong_status"
          ? `this run is ${outcome.status ?? "not reviewable"}`
          : "run not found";
    return html(res, status, pageShell("Approve failed", deps.revision, `<h1>Approve failed</h1><p>${escapeHtml(detail)}</p><p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
  }
  redirect(res, `/runs/${runId}`);
}

async function handleExport(ctx: Ctx, res: ServerResponse, runId: string): Promise<void> {
  const { db, deps, connections, recheck } = ctx;
  const run = getRun(db, runId);
  if (run === undefined) return html(res, 404, pageShell("Not found", deps.revision, "<h1>Not found</h1>"));
  const approval = getApproval(db, runId);
  if (run.status !== "approved" || approval === undefined) {
    return html(res, 409, pageShell("Export failed", deps.revision, `<h1>Export failed</h1><p>This run is ${escapeHtml(run.status)}; only approved runs can be exported.</p><p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
  }
  const fail = (status: number, result: "blocked_stale" | "blocked_unavailable", detail: unknown, body: string): void => {
    recordExport(db, {
      runId,
      approvalId: approval.id,
      at: new Date().toISOString(),
      result,
      detailJson: JSON.stringify(detail),
      draftHash: run.draft_hash,
    });
    html(res, status, pageShell("Export blocked", deps.revision, `${body}<p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
  };

  let tuple: SourceTuple;
  try {
    const parsed: unknown = JSON.parse(run.source_tuple_json);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    tuple = parsed as SourceTuple;
  } catch {
    return fail(503, "blocked_unavailable", "stored source tuple unreadable", "<h1>Export blocked</h1><p>The stored source tuple is unreadable.</p>");
  }

  try {
    const conns = await connections();
    const box = conns.find((c) => c.provider === "box");
    if (box === undefined) {
      return fail(503, "blocked_unavailable", "box connector not configured", "<h1>Export blocked</h1><p>The Box connector is not configured.</p>");
    }
    const outcome = await recheck(box.gatewayBaseUrl, "0", deps.boxFolder, tuple, {
      timeoutMs: deps.recheckTimeoutMs,
    });
    if (!outcome.ok) {
      return fail(503, "blocked_unavailable", outcome.detail, `<h1>Export blocked</h1><p>The source files could not be re-read right now (${escapeHtml(outcome.detail)}). The run stays approved; try again.</p>`);
    }
    if (outcome.changes.length > 0) {
      markStale(db, runId, JSON.stringify(outcome.changes));
      const items = outcome.changes
        .map((c) => `<li>${escapeHtml(c.fileName)}: ${escapeHtml(c.kind)}</li>`)
        .join("");
      return fail(409, "blocked_stale", outcome.changes, `<h1>Export blocked</h1><p>The source files changed since approval:</p><ul>${items}</ul>`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(503, "blocked_unavailable", detail, `<h1>Export blocked</h1><p>The recheck failed (${escapeHtml(detail)}). The run stays approved; try again.</p>`);
  }

  recordExport(db, {
    runId,
    approvalId: approval.id,
    at: new Date().toISOString(),
    result: "exported",
    detailJson: null,
    draftHash: run.draft_hash,
  });
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="caveat-draft-${runId}-v1.txt"`,
    ...SECURITY_HEADERS,
  });
  res.end(run.draft_text);
}

function routeRequest(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> | void {
  const { db, deps } = ctx;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (method === "GET" && path === "/healthz") {
    return text(res, 200, "ok");
  }
  if (method === "GET" && path === "/app.css") {
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(APP_CSS);
    return;
  }
  if (method === "POST" && !sameOrigin(req)) {
    return html(res, 403, pageShell("Forbidden", deps.revision, "<h1>Forbidden</h1><p>Origin check failed.</p>"));
  }
  if (method === "POST" && path === "/runs") {
    const runId = newRunId();
    createRun(db, {
      id: runId,
      createdAt: new Date().toISOString(),
      sourceTupleJson: "[]",
      receiptJson: "{}",
      receiptHash: "",
      draftText: "",
      draftHash: "",
    });
    kickRun(ctx, runId);
    return redirect(res, `/runs/${runId}`);
  }
  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (method === "GET" && runMatch !== null) {
    const run = getRun(db, runMatch[1]!);
    if (run === undefined) {
      return html(res, 404, pageShell("Not found", deps.revision, "<h1>Not found</h1><p><a href=\"/\">Runs</a></p>"));
    }
    return html(res, 200, renderRun(run, {
      revision: deps.revision,
      approver: deps.approver,
      approval: getApproval(db, run.id),
      exports: listExports(db, run.id),
    }));
  }
  const approveMatch = /^\/runs\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approveMatch !== null) {
    return handleApprove(ctx, req, res, approveMatch[1]!);
  }
  const exportMatch = /^\/runs\/([^/]+)\/export$/.exec(path);
  if (method === "POST" && exportMatch !== null) {
    return handleExport(ctx, res, exportMatch[1]!);
  }
  if (method === "GET" && path === "/") {
    return html(res, 200, renderRunList(listRuns(db), deps.revision));
  }
  return html(res, 404, pageShell("Not found", deps.revision, "<h1>Not found</h1><p><a href=\"/\">Runs</a></p>"));
}

export function createApp(deps: AppDeps): Server {
  const ctx: Ctx = {
    db: deps.db,
    deps,
    pipeline: deps.pipeline ?? runPipeline,
    connections: deps.connections ?? listConnections,
    recheck: deps.recheck ?? recheckFolder,
    holdTask: deps.holdTask ?? startTaskHold,
  };
  return createServer((req, res) => {
    Promise.resolve(routeRequest(ctx, req, res)).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        html(res, 500, pageShell("Error", deps.revision, `<h1>Server error</h1><p>${escapeHtml(detail)}</p>`));
      } catch {
        // response already sent
      }
    });
  });
}
