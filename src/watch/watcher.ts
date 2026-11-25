import type { DatabaseSync } from "node:sqlite";

import { findFolderByName, listFolder } from "../evidence/box.ts";
import { diffSourceTuple, recheckFolder } from "../evidence/recheck.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { listConnections } from "../gateway.ts";
import type { Connection } from "../gateway.ts";
import type { RunReceipt } from "../review/receipt.ts";
import { isRecord } from "../shape.ts";
import {
  hasRunningRun,
  latestWatchEvent,
  listRuns,
  markStale,
  newRowId,
  recordWatchEvent,
} from "../store/db.ts";

export type WatcherResult =
  | "no_change"
  | "change_found"
  | "box_unavailable"
  | "error"
  | "skipped_busy";

// In-memory poll state only — no-change ticks must not write rows.
export type WatcherState = {
  lastCheckedAt: string | null;
  lastResult: WatcherResult | null;
};

export type PreviousRun = {
  runId: string;
  receipt: RunReceipt;
  sourceTuple: SourceTuple;
};

export type WatcherDeps = {
  db: DatabaseSync;
  boxFolder: string;
  intervalMs: number;
  // Creates the run row and starts the pipeline. Returns the new run id.
  startRun: (args: {
    trigger: "watcher";
    previous?: PreviousRun;
    // The confirmed tuple the watcher already fetched — stored on the run row
    // immediately so a failed watcher run is not retried.
    sourceTuple?: SourceTuple;
    onFinish?: (status: string) => void;
  }) => string;
  connections?: () => Promise<Connection[]>;
  findFolder?: typeof findFolderByName;
  listFolderItems?: typeof listFolder;
  recheck?: typeof recheckFolder;
  recheckTimeoutMs?: number;
  now?: () => Date;
};

// The cheap poll asks for version + sha1 metadata only — no bytes are
// downloaded unless the listing differs from the latest run's tuple.
const POLL_FIELDS = "id,type,name,sha1,file_version";

function parseTuple(json: string): SourceTuple | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SourceTuple) : undefined;
  } catch {
    return undefined;
  }
}

function parseReceipt(json: string): RunReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) && typeof parsed.receiptVersion === "string"
      ? (parsed as RunReceipt)
      : undefined;
  } catch {
    return undefined;
  }
}

function recordEvent(
  deps: WatcherDeps,
  result: "changed" | "unavailable" | "error" | "run_started" | "run_failed",
  detail: unknown,
  runId?: string,
): void {
  const detailJson = detail === undefined ? undefined : JSON.stringify(detail);
  // Dedupe consecutive identical events so a flapping Box does not fill the log.
  if (result === "unavailable" || result === "error") {
    const last = latestWatchEvent(deps.db);
    if (last !== undefined && last.result === result && last.detail_json === detailJson) {
      return;
    }
  }
  recordWatchEvent(deps.db, {
    id: newRowId("watch"),
    at: (deps.now ?? (() => new Date()))().toISOString(),
    result,
    ...(detailJson !== undefined ? { detailJson } : {}),
    ...(runId !== undefined ? { runId } : {}),
  });
}

// Folder files the pipeline will consume when present. A listed optional
// file that is absent from the run's tuple counts as a change (a first
// upload must replan); removing one is caught by the tuple walk below.
export const OPTIONAL_SOURCE_FILES = ["my-cash.csv"];

// True when the folder listing's files exactly cover the latest run's tuple:
// same names, same file ids, same version ids. Extra folder entries are
// ignored — except names in OPTIONAL_SOURCE_FILES, which would enter the
// next tuple.
function listingMatchesTuple(
  listing: Awaited<ReturnType<typeof listFolder>>,
  tuple: SourceTuple,
): boolean {
  const files = listing.filter((e) => e.type === "file");
  for (const source of tuple) {
    const entry = files.find((e) => e.name === source.fileName);
    if (
      entry === undefined ||
      entry.id !== source.fileId ||
      entry.versionId !== source.versionId
    ) {
      return false;
    }
  }
  const tupleNames = new Set(tuple.map((t) => t.fileName));
  for (const name of OPTIONAL_SOURCE_FILES) {
    if (!tupleNames.has(name) && files.some((e) => e.name === name)) {
      return false;
    }
  }
  return true;
}

// One watcher tick. Exported for tests; startWatcher schedules it.
export async function watchTick(deps: WatcherDeps, state: WatcherState): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const connections = deps.connections ?? listConnections;
  const findFolder = deps.findFolder ?? findFolderByName;
  const listItems = deps.listFolderItems ?? listFolder;
  const recheck = deps.recheck ?? recheckFolder;
  state.lastCheckedAt = now().toISOString();

  // A run in flight already holds the folder state in flux; do nothing.
  if (hasRunningRun(deps.db)) {
    state.lastResult = "skipped_busy";
    return;
  }

  try {
    const conns = await connections();
    const box = conns.find((c) => c.provider === "box");
    if (box === undefined) {
      state.lastResult = "box_unavailable";
      recordEvent(deps, "unavailable", { detail: "box connector not configured" });
      return;
    }

    const folder = await findFolder(box.gatewayBaseUrl, "0", deps.boxFolder);
    if (folder === undefined) {
      state.lastResult = "box_unavailable";
      recordEvent(deps, "unavailable", { detail: `folder ${deps.boxFolder} not found` });
      return;
    }
    const listing = await listItems(box.gatewayBaseUrl, folder.id, {
      fields: POLL_FIELDS,
    });

    // A run that failed before reading Box stores an empty tuple; it must not
    // become the baseline, or every listing would match it vacuously.
    const latestRun = listRuns(deps.db).find(
      (r) => (parseTuple(r.source_tuple_json)?.length ?? 0) > 0,
    );
    const latestTuple =
      latestRun === undefined ? undefined : parseTuple(latestRun.source_tuple_json);
    if (latestTuple !== undefined && listingMatchesTuple(listing, latestTuple)) {
      state.lastResult = "no_change";
      return;
    }

    // The listing differs (or there is no baseline): confirm with full bytes.
    const outcome = await recheck(
      box.gatewayBaseUrl,
      "0",
      deps.boxFolder,
      latestTuple ?? [],
      { timeoutMs: deps.recheckTimeoutMs ?? 30_000 },
    );
    if (!outcome.ok) {
      state.lastResult = "box_unavailable";
      recordEvent(deps, "unavailable", { detail: outcome.detail });
      return;
    }
    const confirmed = outcome.tuple;

    // Trigger only when the confirmed tuple differs from the latest run's —
    // if the watcher's own run for this tuple already failed, do not retry it.
    if (
      latestTuple !== undefined &&
      latestRun !== undefined &&
      diffSourceTuple(latestTuple, confirmed).length === 0
    ) {
      state.lastResult = "no_change";
      return;
    }

    // Mark stale every run still holding a verdict whose tuple differs.
    for (const run of listRuns(deps.db)) {
      if (
        run.status !== "approved" &&
        run.status !== "reviewable" &&
        run.status !== "needs_review"
      ) {
        continue;
      }
      const runTuple = parseTuple(run.source_tuple_json);
      if (runTuple === undefined) continue;
      const changes = diffSourceTuple(runTuple, confirmed);
      if (changes.length > 0) {
        markStale(deps.db, run.id, JSON.stringify(changes));
      }
    }
    recordEvent(deps, "changed", { changes: outcome.changes });
    state.lastResult = "change_found";

    // Baseline for incremental work: the most recent non-failed run whose
    // receipt carries digests; otherwise the latest non-failed run at all.
    const candidates = listRuns(deps.db).filter(
      (r) => r.status !== "failed" && r.status !== "running",
    );
    const withDigests = candidates.find((r) => {
      const receipt = parseReceipt(r.receipt_json);
      return (
        receipt?.sectionDigests !== undefined &&
        receipt.typedCallDigests !== undefined
      );
    });
    const previousRow = withDigests ?? candidates[0];
    const previous =
      previousRow === undefined
        ? undefined
        : {
            runId: previousRow.id,
            receipt: parseReceipt(previousRow.receipt_json) ?? ({} as RunReceipt),
            sourceTuple: parseTuple(previousRow.source_tuple_json) ?? [],
          };

    const runId = deps.startRun({
      trigger: "watcher",
      sourceTuple: confirmed,
      ...(previous !== undefined ? { previous } : {}),
      onFinish: (status) => {
        if (status === "failed") {
          recordEvent(
            deps,
            "run_failed",
            {
              detail: "the watcher-started run failed; start a run manually to retry",
            },
            runId,
          );
        }
      },
    });
    recordEvent(deps, "run_started", { changes: outcome.changes }, runId);
  } catch (error) {
    state.lastResult = "error";
    recordEvent(deps, "error", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export type Watcher = {
  state: WatcherState;
  // Stops the timers; a tick already in flight finishes.
  stop: () => void;
};

// First tick ~5 s after start, then every interval. intervalMs 0 disables the
// watcher entirely (an inert object is returned so the UI can still read it).
export function startWatcher(deps: WatcherDeps): Watcher {
  const state: WatcherState = { lastCheckedAt: null, lastResult: null };
  if (deps.intervalMs <= 0) {
    return { state, stop: () => {} };
  }
  let ticking = false;
  const fire = (): void => {
    if (ticking) return;
    ticking = true;
    void watchTick(deps, state).finally(() => {
      ticking = false;
    });
  };
  const first = setTimeout(fire, 5_000);
  const interval = setInterval(fire, deps.intervalMs);
  first.unref();
  interval.unref();
  return {
    state,
    stop: () => {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
