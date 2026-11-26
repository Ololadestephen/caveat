import type { DatabaseSync } from "node:sqlite";

import { findFolderByName, listFolder } from "../evidence/box.ts";
import { diffSourceTuple, recheckFolder } from "../evidence/recheck.ts";
import type { RecheckOutcome, SourceTuple } from "../evidence/recheck.ts";
import { listConnections } from "../gateway.ts";
import type { Connection } from "../gateway.ts";
import type { RunReceipt } from "../review/receipt.ts";
import {
  hasRunningRun,
  latestWatchEvent,
  listRuns,
  markStale,
  newRowId,
  recordWatchEvent,
  selectBaseline,
  selectCarrySources,
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
  // Last tick outcome per contract id.
  results: Record<string, WatcherResult>;
};

export type PreviousRun = {
  runId: string;
  receipt: RunReceipt;
  sourceTuple: SourceTuple;
};

// One contract profile's folder, ticked in order. A change in any folder
// starts that contract's run; the remaining folders wait for the next tick
// because only one run may be in flight.
export type WatcherContract = { id: string; boxFolder: string };

export type WatcherDeps = {
  db: DatabaseSync;
  contracts: WatcherContract[];
  intervalMs: number;
  // Creates the run row and starts the pipeline. Returns the new run id.
  startRun: (args: {
    trigger: "watcher";
    contract: string;
    previous?: PreviousRun;
    carrySources?: { runId: string; receipt: RunReceipt }[];
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
export const OPTIONAL_SOURCE_FILES = ["my-cash.csv", "04-client-reply.pdf"];

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

// Listing check plus the full-bytes recheck. Returns the confirmed tuple when
// the folder really changed; undefined ends the tick — lastResult and any
// event are already written.
async function confirmChange(
  deps: WatcherDeps,
  state: WatcherState,
  contract: WatcherContract,
  fns: {
    findFolder: NonNullable<WatcherDeps["findFolder"]>;
    listItems: NonNullable<WatcherDeps["listFolderItems"]>;
    recheck: NonNullable<WatcherDeps["recheck"]>;
    box: Connection;
  },
): Promise<{ confirmed: SourceTuple; outcome: Extract<RecheckOutcome, { ok: true }> } | undefined> {
  const { findFolder, listItems, recheck, box } = fns;
  const folder = await findFolder(box.gatewayBaseUrl, "0", contract.boxFolder);
  if (folder === undefined) {
    state.results[contract.id] = "box_unavailable";
    recordEvent(deps, "unavailable", {
      contract: contract.id,
      detail: `folder ${contract.boxFolder} not found`,
    });
    return undefined;
  }
  const listing = await listItems(box.gatewayBaseUrl, folder.id, {
    fields: POLL_FIELDS,
  });

  // A run that failed before reading Box stores an empty tuple; it must not
  // become the baseline, or every listing would match it vacuously.
  const latestRun = listRuns(deps.db, contract.id).find(
    (r) => (parseTuple(r.source_tuple_json)?.length ?? 0) > 0,
  );
  const latestTuple =
    latestRun === undefined ? undefined : parseTuple(latestRun.source_tuple_json);
  if (latestTuple !== undefined && listingMatchesTuple(listing, latestTuple)) {
    state.results[contract.id] = "no_change";
    return undefined;
  }

  // The listing differs (or there is no baseline): confirm with full bytes.
  const outcome = await recheck(
    box.gatewayBaseUrl,
    "0",
    contract.boxFolder,
    latestTuple ?? [],
    { timeoutMs: deps.recheckTimeoutMs ?? 30_000 },
  );
  if (!outcome.ok) {
    state.results[contract.id] = "box_unavailable";
    recordEvent(deps, "unavailable", { contract: contract.id, detail: outcome.detail });
    return undefined;
  }
  const confirmed = outcome.tuple;

  // Trigger only when the confirmed tuple differs from the latest run's —
  // if the watcher's own run for this tuple already failed, do not retry it.
  if (
    latestTuple !== undefined &&
    latestRun !== undefined &&
    diffSourceTuple(latestTuple, confirmed).length === 0
  ) {
    state.results[contract.id] = "no_change";
    return undefined;
  }
  return { confirmed, outcome };
}

// Mark stale every run still holding a verdict whose tuple differs, then
// record the change and start the run on the confirmed tuple.
function startWatcherRun(
  deps: WatcherDeps,
  state: WatcherState,
  contract: WatcherContract,
  confirmed: SourceTuple,
  outcome: Extract<RecheckOutcome, { ok: true }>,
): void {
  for (const run of listRuns(deps.db, contract.id)) {
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
  recordEvent(deps, "changed", { contract: contract.id, changes: outcome.changes });
  state.results[contract.id] = "change_found";

  // Baseline for incremental work: the most recent run whose stored receipt
  // passed every gate and carries digests; see selectBaseline.
  const previous = selectBaseline(deps.db, contract.id);
  const carrySources = selectCarrySources(deps.db, contract.id);

  const runId = deps.startRun({
    trigger: "watcher",
    contract: contract.id,
    sourceTuple: confirmed,
    ...(previous !== undefined ? { previous } : {}),
    carrySources,
    onFinish: (status) => {
      if (status === "failed") {
        recordEvent(
          deps,
          "run_failed",
          {
            contract: contract.id,
            detail: "the watcher-started run failed; start a run manually to retry",
          },
          runId,
        );
      }
    },
  });
  recordEvent(deps, "run_started", { contract: contract.id, changes: outcome.changes }, runId);
}

// One watcher tick. Exported for tests; startWatcher schedules it.
// Dependency defaults for a tick — each is overridable in tests.
function resolveDeps(deps: WatcherDeps): {
  now: NonNullable<WatcherDeps["now"]>;
  connections: NonNullable<WatcherDeps["connections"]>;
  findFolder: NonNullable<WatcherDeps["findFolder"]>;
  listItems: NonNullable<WatcherDeps["listFolderItems"]>;
  recheck: NonNullable<WatcherDeps["recheck"]>;
} {
  return {
    now: deps.now ?? (() => new Date()),
    connections: deps.connections ?? listConnections,
    findFolder: deps.findFolder ?? findFolderByName,
    listItems: deps.listFolderItems ?? listFolder,
    recheck: deps.recheck ?? recheckFolder,
  };
}

export async function watchTick(deps: WatcherDeps, state: WatcherState): Promise<void> {
  const { now, connections, findFolder, listItems, recheck } = resolveDeps(deps);
  state.lastCheckedAt = now().toISOString();

  // A run in flight already holds the folder state in flux; do nothing.
  if (hasRunningRun(deps.db)) {
    for (const contract of deps.contracts) state.results[contract.id] = "skipped_busy";
    return;
  }

  try {
    const conns = await connections();
    const box = conns.find((c) => c.provider === "box");
    if (box === undefined) {
      for (const contract of deps.contracts) state.results[contract.id] = "box_unavailable";
      recordEvent(deps, "unavailable", { detail: "box connector not configured" });
      return;
    }

    for (const contract of deps.contracts) {
      // A run started for an earlier folder is already in flight; the rest of
      // the folders are checked again on the next tick.
      if (hasRunningRun(deps.db)) return;
      const change = await confirmChange(deps, state, contract, {
        findFolder,
        listItems,
        recheck,
        box,
      });
      if (change === undefined) continue;
      startWatcherRun(deps, state, contract, change.confirmed, change.outcome);
      return;
    }
  } catch (error) {
    state.results.error = "error";
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

// Runs one tick unless one is already in flight; the interval keeps firing
// even while a slow tick is still running, so re-entry is guarded here.
function fireTick(
  deps: WatcherDeps,
  state: WatcherState,
  tick: { ticking: boolean },
): void {
  if (tick.ticking) return;
  tick.ticking = true;
  void watchTick(deps, state).finally(() => {
    tick.ticking = false;
  });
}

// First tick ~5 s after start, then every interval. intervalMs 0 disables the
// watcher entirely (an inert object is returned so the UI can still read it).
export function startWatcher(deps: WatcherDeps): Watcher {
  const state: WatcherState = { lastCheckedAt: null, results: {} };
  if (deps.intervalMs <= 0) {
    return { state, stop: () => {} };
  }
  const tick = { ticking: false };
  const fire = (): void => fireTick(deps, state, tick);
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
