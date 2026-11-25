import type { SourceTuple } from "../evidence/recheck.ts";
import { escapeHtml } from "../review/decision-card.ts";
import type { RunReceipt } from "../review/receipt.ts";
import { renderReviewBody } from "../review/review-page.ts";
import type { ApprovalRow, ExportRow, RunRow, WatchEventRow } from "../store/db.ts";

export function pageShell(title: string, revision: string, body: string): string {
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

export function statusBadge(status: string, supersededBy: string | null): string {
  const superseded =
    supersededBy !== null
      ? ` <span class="badge badge--superseded">superseded</span>`
      : "";
  return `<span class="badge badge--${escapeHtml(status)}">${escapeHtml(status)}</span>${superseded}`;
}

function sourceSummary(tupleJson: string): string {
  try {
    const tuple = JSON.parse(tupleJson) as SourceTuple;
    if (!Array.isArray(tuple)) return "—";
    return tuple
      .map((f) => `${escapeHtml(f.fileName)} ${escapeHtml(f.sha256.slice(0, 12))}`)
      .join("<br>");
  } catch {
    return "—";
  }
}

export type WatcherView = {
  enabled: boolean;
  intervalMs: number;
  boxFolder: string;
  lastCheckedAt: string | null;
  lastResult: string | null;
  events: WatchEventRow[];
};

const WATCH_RESULT_LABELS: Record<string, string> = {
  no_change: "no change",
  change_found: "change found",
  box_unavailable: "Box unavailable",
  error: "error",
  skipped_busy: "skipped — a run is in progress",
};

function renderWatcherLine(watcher: WatcherView | undefined): string {
  if (watcher === undefined) return "";
  if (!watcher.enabled) {
    return `<p class="watcher"><strong>Box watcher:</strong> disabled.</p>`;
  }
  const seconds = Math.round(watcher.intervalMs / 1000);
  const last =
    watcher.lastCheckedAt === null
      ? "not checked yet"
      : `${escapeHtml(watcher.lastCheckedAt)}, ${
          WATCH_RESULT_LABELS[watcher.lastResult ?? ""] ?? "no change"
        }`;
  const events = watcher.events
    .map((e) => `<li>${escapeHtml(e.at)} — ${escapeHtml(e.result)}${e.run_id !== null ? ` (run <a href="/runs/${escapeHtml(e.run_id)}">${escapeHtml(e.run_id)}</a>)` : ""}</li>`)
    .join("");
  return `<div class="watcher"><p><strong>Box watcher:</strong> checks the ${escapeHtml(watcher.boxFolder)} folder every ${seconds} s while the coordinator is awake. Last check: ${last}.</p>${
    watcher.events.length > 0 ? `<ul>${events}</ul>` : ""
  }</div>`;
}

export function renderRunList(
  runs: RunRow[],
  revision: string,
  watcher?: WatcherView,
): string {
  const rows = runs
    .map((run) => {
      const receiptSha = run.receipt_hash.length > 0 ? run.receipt_hash.slice(0, 12) : "—";
      return `    <tr><td><a href="/runs/${escapeHtml(run.id)}">${escapeHtml(run.id)}</a></td><td>${statusBadge(run.status, run.superseded_by)}</td><td>${escapeHtml(run.created_at)}</td><td>${escapeHtml(run.trigger)}</td><td>${sourceSummary(run.source_tuple_json)}</td><td><code>${receiptSha}</code></td></tr>`;
    })
    .join("\n");
  return pageShell("Caveat runs", revision, `<nav><strong>Caveat</strong> — contract cash review</nav>
<h1>Runs</h1>
${renderWatcherLine(watcher)}
<form method="POST" action="/runs"><button type="submit">Start a run</button></form>
<table class="runs">
  <tr><th>Run</th><th>Status</th><th>Created</th><th>Started by</th><th>Sources</th><th>Receipt</th></tr>
${rows}
</table>`);
}

type StaleChange = {
  fileName: string;
  kind: string;
  oldVersionTag?: string;
  newVersionTag?: string;
  oldSha12?: string;
  newSha12?: string;
};

export function renderStaleChange(c: StaleChange): string {
  const versions =
    c.oldVersionTag !== undefined || c.newVersionTag !== undefined
      ? ` (version ${escapeHtml(c.oldVersionTag ?? "—")} → ${escapeHtml(c.newVersionTag ?? "—")})`
      : "";
  const hashes =
    c.oldSha12 !== c.newSha12
      ? ` (sha ${escapeHtml(c.oldSha12 ?? "—")} → ${escapeHtml(c.newSha12 ?? "—")})`
      : "";
  return `<li>${escapeHtml(c.fileName)}: ${escapeHtml(c.kind)}${versions}${hashes}</li>`;
}

function renderStaleBanner(run: RunRow): string {
  let changes: string[] = [];
  if (run.stale_detail_json !== null) {
    try {
      changes = (JSON.parse(run.stale_detail_json) as StaleChange[]).map(renderStaleChange);
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

function storedReceipt(receiptJson: string): RunReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(receiptJson);
    if (typeof parsed === "object" && parsed !== null && "receiptVersion" in parsed) {
      return parsed as RunReceipt;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function renderRun(
  run: RunRow,
  view: {
    revision: string;
    approver: string | undefined;
    approval: ApprovalRow | undefined;
    exports: ExportRow[];
  },
): string {
  const parts: string[] = [
    `<nav><a href="/">Caveat runs</a> / ${escapeHtml(run.id)}</nav>`,
    `<h1>${escapeHtml(run.id)}</h1>`,
    `<p>${statusBadge(run.status, run.superseded_by)} · created ${escapeHtml(run.created_at)} · started by ${escapeHtml(run.trigger)}${run.status_reason !== null ? ` · ${escapeHtml(run.status_reason)}` : ""}</p>`,
  ];
  if (run.status === "stale") parts.push(renderStaleBanner(run));
  if (run.superseded_by !== null && run.status !== "stale") {
    parts.push(
      `<div class="banner banner--warn"><strong>Superseded</strong> by <a href="/runs/${escapeHtml(run.superseded_by)}">${escapeHtml(run.superseded_by)}</a>.</div>`,
    );
  }

  if (run.status === "running") {
    parts.push(`<div class="banner"><strong>Run in progress.</strong> Refresh this page.</div>`);
  }

  if (run.receipt_hash.length > 0) {
    parts.push(
      `<p>Receipt <code>sha256 ${escapeHtml(run.receipt_hash)}</code><br>Draft <code>sha256 ${escapeHtml(run.draft_hash)}</code></p>`,
    );
  }

  if (run.status === "reviewable" && view.approver !== undefined) {
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

  if (view.approval !== undefined) {
    parts.push(
      `<h2>Approval</h2><p>Approved by ${escapeHtml(view.approval.approved_by)} at ${escapeHtml(view.approval.approved_at)} (approval <code>${escapeHtml(view.approval.id)}</code>).</p>`,
    );
  }
  if (view.exports.length > 0) {
    const rows = view.exports
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
  const receipt = storedReceipt(run.receipt_json);
  if (receipt !== undefined) {
    parts.push(renderReviewBody(receipt));
  }
  return pageShell(run.id, view.revision, parts.join("\n"));
}
