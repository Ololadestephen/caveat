import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { recheckFolder } from "../evidence/recheck.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { listConnections, runPipeline } from "../pipeline/run-pipeline.ts";
import type { Connection, PipelineConfig } from "../pipeline/run-pipeline.ts";
import { escapeHtml } from "../review/decision-card.ts";
import { draftHash, receiptHash, renderDraft } from "../review/draft.ts";
import type { RunReceipt } from "../review/receipt.ts";
import {
  renderReviewBody,
  REVIEW_PAGE_CSS,
} from "../review/review-page.ts";
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
import type { RunRow } from "../store/db.ts";
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

function page(title: string, revision: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
${body}
<footer>caveat · deployed revision ${escapeHtml(revision)}</footer>
</body>
</html>`;
}

function badge(status: string, supersededBy: string | null): string {
  const superseded =
    supersededBy !== null
      ? ` <span class="badge badge--superseded">superseded</span>`
      : "";
  return `<span class="badge badge--${escapeHtml(status)}">${escapeHtml(status)}</span>${superseded}`;
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

function sourceSummary(tupleJson: string): string {
  try {
    const tuple = JSON.parse(tupleJson) as SourceTuple;
    if (!Array.isArray(tuple)) return "—";
    return tuple.map((f) => `${escapeHtml(f.fileName)} ${escapeHtml(f.sha256.slice(0, 12))}`).join("<br>");
  } catch {
    return "—";
  }
}

export function createApp(deps: AppDeps): Server {
  const { db } = deps;
  const pipeline = deps.pipeline ?? runPipeline;
  const connections = deps.connections ?? listConnections;
  const recheck = deps.recheck ?? recheckFolder;
  const holdTask = deps.holdTask ?? startTaskHold;

  function kickRun(runId: string): void {
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

  function renderRunList(): string {
    const rows = listRuns(db)
      .map((run) => {
        const receiptSha = run.receipt_hash.length > 0 ? run.receipt_hash.slice(0, 12) : "—";
        return `    <tr><td><a href="/runs/${escapeHtml(run.id)}">${escapeHtml(run.id)}</a></td><td>${badge(run.status, run.superseded_by)}</td><td>${escapeHtml(run.created_at)}</td><td>${sourceSummary(run.source_tuple_json)}</td><td><code>${receiptSha}</code></td></tr>`;
      })
      .join("\n");
    return page("Caveat runs", deps.revision, `<nav><strong>Caveat</strong> — contract cash review</nav>
<h1>Runs</h1>
<form method="POST" action="/runs"><button type="submit">Start a run</button></form>
<table class="runs">
  <tr><th>Run</th><th>Status</th><th>Created</th><th>Sources</th><th>Receipt</th></tr>
${rows}
</table>`);
  }

  function renderStaleBanner(run: RunRow): string {
    let changes: string[] = [];
    if (run.stale_detail_json !== null) {
      try {
        const parsed = JSON.parse(run.stale_detail_json) as {
          fileName: string;
          kind: string;
          oldVersionTag?: string;
          newVersionTag?: string;
          oldSha12?: string;
          newSha12?: string;
        }[];
        changes = parsed.map(
          (c) =>
            `<li>${escapeHtml(c.fileName)}: ${escapeHtml(c.kind)}${c.oldVersionTag !== undefined || c.newVersionTag !== undefined ? ` (version ${escapeHtml(c.oldVersionTag ?? "—")} → ${escapeHtml(c.newVersionTag ?? "—")})` : ""}${c.oldSha12 !== c.newSha12 ? ` (sha ${escapeHtml(c.oldSha12 ?? "—")} → ${escapeHtml(c.newSha12 ?? "—")})` : ""}</li>`,
        );
      } catch {
        changes = [];
      }
    }
    const superseded =
      run.superseded_by !== null
        ? `<p>Superseded by <a href="/runs/${escapeHtml(run.superseded_by)}">${escapeHtml(run.superseded_by)}</a>.</p>`
        : "";
    return `<div class="banner banner--warn"><strong>Stale.</strong> The source files changed after approval:<ul>${changes.join("")}</ul></div>${superseded}`;
  }

  function renderRun(run: RunRow): string {
    const parts: string[] = [
      `<nav><a href="/">Caveat runs</a> / ${escapeHtml(run.id)}</nav>`,
      `<h1>${escapeHtml(run.id)}</h1>`,
      `<p>${badge(run.status, run.superseded_by)} · created ${escapeHtml(run.created_at)}${run.status_reason !== null ? ` · ${escapeHtml(run.status_reason)}` : ""}</p>`,
    ];
    if (run.status === "stale") parts.push(renderStaleBanner(run));
    if (run.superseded_by !== null && run.status !== "stale") {
      parts.push(
        `<div class="banner banner--warn"><strong>Superseded</strong> by <a href="/runs/${escapeHtml(run.superseded_by)}">${escapeHtml(run.superseded_by)}</a>.</div>`,
      );
    }

    let receipt: RunReceipt | undefined;
    try {
      const parsed: unknown = JSON.parse(run.receipt_json);
      if (typeof parsed === "object" && parsed !== null && "receiptVersion" in parsed) {
        receipt = parsed as RunReceipt;
      }
    } catch {
      receipt = undefined;
    }

    if (run.status === "running") {
      parts.push(`<div class="banner"><strong>Run in progress.</strong> Refresh this page.</div>`);
    }

    if (run.receipt_hash.length > 0) {
      parts.push(
        `<p>Receipt <code>sha256 ${escapeHtml(run.receipt_hash)}</code><br>Draft <code>sha256 ${escapeHtml(run.draft_hash)}</code></p>`,
      );
    }

    if (run.status === "reviewable" && deps.approver !== undefined) {
      parts.push(
        `<form method="POST" action="/runs/${escapeHtml(run.id)}/approve">
  <input type="hidden" name="receiptHash" value="${escapeHtml(run.receipt_hash)}">
  <input type="hidden" name="draftHash" value="${escapeHtml(run.draft_hash)}">
  <button type="submit">Approve this receipt</button>
</form>`,
      );
    }
    if (run.status === "approved") {
      parts.push(
        `<form method="POST" action="/runs/${escapeHtml(run.id)}/export"><button type="submit">Export draft</button></form>`,
      );
    }

    const approval = getApproval(db, run.id);
    if (approval !== undefined) {
      parts.push(
        `<h2>Approval</h2><p>Approved by ${escapeHtml(approval.approved_by)} at ${escapeHtml(approval.approved_at)} (approval <code>${escapeHtml(approval.id)}</code>).</p>`,
      );
    }
    const exports = listExports(db, run.id);
    if (exports.length > 0) {
      const rows = exports
        .map(
          (e) =>
            `    <tr><td>${escapeHtml(e.at)}</td><td>${escapeHtml(e.result)}</td><td><code>${escapeHtml(e.draft_hash.slice(0, 12))}</code></td></tr>`,
        )
        .join("\n");
      parts.push(`<h2>Export attempts</h2><table><tr><th>At</th><th>Result</th><th>Draft</th></tr>\n${rows}\n</table>`);
    }

    if (run.draft_text.length > 0) {
      parts.push(`<h2>Draft</h2><pre class="draft">${escapeHtml(run.draft_text)}</pre>`);
    }
    if (receipt !== undefined) {
      parts.push(renderReviewBody(receipt));
    }
    return page(run.id, deps.revision, parts.join("\n"));
  }

  async function handleApprove(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const run = getRun(db, runId);
    if (run === undefined) return html(res, 404, page("Not found", deps.revision, "<h1>Not found</h1>"));
    if (deps.approver === undefined) {
      return html(res, 503, page("Approver not configured", deps.revision, "<h1>Approver not configured</h1>"));
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
      return html(res, status, page("Approve failed", deps.revision, `<h1>Approve failed</h1><p>${escapeHtml(detail)}</p><p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
    }
    redirect(res, `/runs/${runId}`);
  }

  async function handleExport(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const run = getRun(db, runId);
    if (run === undefined) return html(res, 404, page("Not found", deps.revision, "<h1>Not found</h1>"));
    const approval = getApproval(db, runId);
    if (run.status !== "approved" || approval === undefined) {
      return html(res, 409, page("Export failed", deps.revision, `<h1>Export failed</h1><p>This run is ${escapeHtml(run.status)}; only approved runs can be exported.</p><p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
    }
    const fail = (status: number, result: "blocked_stale" | "blocked_unavailable", detail: string, body: string): void => {
      recordExport(db, {
        runId,
        approvalId: approval.id,
        at: new Date().toISOString(),
        result,
        detailJson: JSON.stringify(detail),
        draftHash: run.draft_hash,
      });
      html(res, status, page("Export blocked", deps.revision, `${body}<p><a href="/runs/${escapeHtml(runId)}">Back to the run</a></p>`));
    };

    let tuple: SourceTuple;
    try {
      tuple = JSON.parse(run.source_tuple_json) as SourceTuple;
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
        return fail(409, "blocked_stale", JSON.stringify(outcome.changes), `<h1>Export blocked</h1><p>The source files changed since approval:</p><ul>${items}</ul>`);
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

  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    void (async () => {
      if (method === "GET" && path === "/healthz") {
        return text(res, 200, "ok");
      }
      if (method === "GET" && path === "/app.css") {
        res.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-cache",
          ...SECURITY_HEADERS,
        });
        return res.end(APP_CSS);
      }
      if (method === "POST") {
        if (!sameOrigin(req)) {
          return html(res, 403, page("Forbidden", deps.revision, "<h1>Forbidden</h1><p>Origin check failed.</p>"));
        }
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
        kickRun(runId);
        return redirect(res, `/runs/${runId}`);
      }
      const runMatch = /^\/runs\/([^/]+)$/.exec(path);
      if (method === "GET" && runMatch !== null) {
        const run = getRun(db, runMatch[1]!);
        if (run === undefined) {
          return html(res, 404, page("Not found", deps.revision, "<h1>Not found</h1><p><a href=\"/\">Runs</a></p>"));
        }
        return html(res, 200, renderRun(run));
      }
      const approveMatch = /^\/runs\/([^/]+)\/approve$/.exec(path);
      if (method === "POST" && approveMatch !== null) {
        return handleApprove(req, res, approveMatch[1]!);
      }
      const exportMatch = /^\/runs\/([^/]+)\/export$/.exec(path);
      if (method === "POST" && exportMatch !== null) {
        return handleExport(req, res, exportMatch[1]!);
      }
      if (method === "GET" && path === "/") {
        return html(res, 200, renderRunList());
      }
      html(res, 404, page("Not found", deps.revision, "<h1>Not found</h1><p><a href=\"/\">Runs</a></p>"));
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        html(res, 500, page("Error", deps.revision, `<h1>Server error</h1><p>${escapeHtml(detail)}</p>`));
      } catch {
        // response already sent
      }
    });
  });
}
