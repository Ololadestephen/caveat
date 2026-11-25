import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoxEntry } from "../evidence/box.ts";
import { diffSourceTuple } from "../evidence/recheck.ts";
import type { RecheckOutcome, SourceTuple } from "../evidence/recheck.ts";
import {
  createRun,
  finishRun,
  getRun,
  listWatchEvents,
  openDb,
} from "../store/db.ts";
import { startWatcher, watchTick } from "./watcher.ts";
import type { WatcherDeps, WatcherState } from "./watcher.ts";

const NAMES = [
  "01-consulting-agreement.pdf",
  "02-first-amendment.pdf",
  "03-second-amendment.pdf",
];

function makeTuple(versionId: string, shaSeed = "same"): SourceTuple {
  return NAMES.map((fileName, i) => ({
    fileName,
    fileId: `file-${i}`,
    versionId,
    sha256: createHash("sha256").update(`${shaSeed}-${i}`).digest("hex"),
    size: 10 + i,
  }));
}

function entriesFor(tuple: SourceTuple): BoxEntry[] {
  return tuple.map((f) => ({
    id: f.fileId,
    type: "file",
    name: f.fileName,
    sha1: "a".repeat(40),
    versionId: f.versionId,
  }));
}

const RECEIPT_WITH_DIGESTS = {
  receiptVersion: "caveat-receipt/2",
  runId: "x",
  status: "reviewable",
  sectionDigests: { "01-consulting-agreement.pdf#§1": "abc" },
  typedCallDigests: { release_timing: "d", escrow_schedule: "s", counteroffer_search: "c" },
};

function seedRun(
  db: DatabaseSync,
  args: {
    id: string;
    createdAt: string;
    status: string;
    sourceTuple: SourceTuple;
    receipt?: object;
    trigger?: "manual" | "watcher";
  },
): void {
  createRun(db, {
    id: args.id,
    createdAt: args.createdAt,
    sourceTupleJson: JSON.stringify(args.sourceTuple),
    receiptJson: JSON.stringify(args.receipt ?? { receiptVersion: "caveat-receipt/2" }),
    receiptHash: "",
    draftText: "",
    draftHash: "",
    ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
  });
  db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(args.status, args.id);
}

type StartedArgs = Parameters<WatcherDeps["startRun"]>[0];
type Started = {
  args: StartedArgs;
  runId: string;
  onFinish?: ((status: string) => void) | undefined;
};

function makeDeps(
  db: DatabaseSync,
  opts: {
    listing?: BoxEntry[];
    findFolder?: WatcherDeps["findFolder"];
    listFolderItems?: WatcherDeps["listFolderItems"];
    recheck?: WatcherDeps["recheck"];
    connections?: WatcherDeps["connections"];
    /** When set, the fake startRun writes a real 'running' row with this id. */
    startRunId?: string;
  } = {},
): { deps: WatcherDeps; state: WatcherState; started: Started[] } {
  const started: Started[] = [];
  const state: WatcherState = { lastCheckedAt: null, lastResult: null };
  const deps: WatcherDeps = {
    db,
    boxFolder: "caveat_TEST",
    intervalMs: 60000,
    connections:
      opts.connections ??
      (() => Promise.resolve([{ provider: "box", gatewayBaseUrl: "http://box.test" }])),
    findFolder:
      opts.findFolder ??
      (() => Promise.resolve({ id: "F1", type: "folder", name: "caveat_TEST" })),
    listFolderItems:
      opts.listFolderItems ?? (() => Promise.resolve(opts.listing ?? [])),
    recheck:
      opts.recheck ??
      (() => Promise.resolve({ ok: false, detail: "recheck not stubbed" } as RecheckOutcome)),
    startRun: (args) => {
      const entry: Started = { args, runId: opts.startRunId ?? "run-w1" };
      entry.onFinish = args.onFinish;
      started.push(entry);
      if (opts.startRunId !== undefined) {
        createRun(db, {
          id: opts.startRunId,
          createdAt: "2026-11-25T03:00:00.000Z",
          sourceTupleJson: JSON.stringify(args.sourceTuple ?? []),
          receiptJson: "{}",
          receiptHash: "",
          draftText: "",
          draftHash: "",
          trigger: "watcher",
        });
      }
      return entry.runId;
    },
    now: () => new Date("2026-11-25T04:00:00.000Z"),
  };
  return { deps, state, started };
}

describe("watchTick", () => {
  it("writes nothing when the folder matches the latest run's tuple", async () => {
    const db = openDb(":memory:");
    const tuple = makeTuple("v1");
    seedRun(db, {
      id: "run-latest",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "approved",
      sourceTuple: tuple,
    });
    const recheck = vi.fn();
    const { deps, state } = makeDeps(db, { listing: entriesFor(tuple), recheck });

    await watchTick(deps, state);

    expect(state.lastResult).toBe("no_change");
    expect(recheck).not.toHaveBeenCalled();
    expect(listWatchEvents(db, 10)).toHaveLength(0);
    expect(getRun(db, "run-latest")?.status).toBe("approved");
  });

  it("marks matching runs stale and starts one watcher run with the right previous", async () => {
    const db = openDb(":memory:");
    const old = makeTuple("v1");
    seedRun(db, {
      id: "run-approved",
      createdAt: "2026-11-25T01:00:00.000Z",
      status: "approved",
      sourceTuple: old,
      receipt: RECEIPT_WITH_DIGESTS,
    });
    seedRun(db, {
      id: "run-reviewable",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "reviewable",
      sourceTuple: old,
      receipt: RECEIPT_WITH_DIGESTS,
    });
    const confirmed = makeTuple("v2");
    const recheck: WatcherDeps["recheck"] = (_gw, _p, _f, approved) =>
      Promise.resolve({
        ok: true,
        tuple: confirmed,
        changes: diffSourceTuple(approved, confirmed),
      });
    const { deps, state, started } = makeDeps(db, {
      listing: entriesFor(makeTuple("v2")),
      recheck,
    });

    await watchTick(deps, state);

    expect(state.lastResult).toBe("change_found");
    const expectedDetail = JSON.stringify(diffSourceTuple(old, confirmed));
    expect(getRun(db, "run-approved")?.status).toBe("stale");
    expect(getRun(db, "run-approved")?.stale_detail_json).toBe(expectedDetail);
    expect(getRun(db, "run-reviewable")?.status).toBe("stale");
    expect(getRun(db, "run-reviewable")?.stale_detail_json).toBe(expectedDetail);

    const events = listWatchEvents(db, 10);
    expect(events.map((e) => e.result)).toEqual(["run_started", "changed"]);

    expect(started).toHaveLength(1);
    expect(started[0]?.args.trigger).toBe("watcher");
    expect(started[0]?.args.sourceTuple).toEqual(confirmed);
    expect(started[0]?.args.previous?.runId).toBe("run-reviewable");
    expect(started[0]?.args.previous?.receipt.sectionDigests).toBeDefined();
    expect(started[0]?.args.previous?.sourceTuple).toEqual(old);
  });

  it("does nothing while a run is still running", async () => {
    const db = openDb(":memory:");
    const old = makeTuple("v1");
    seedRun(db, {
      id: "run-latest",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "reviewable",
      sourceTuple: old,
      receipt: RECEIPT_WITH_DIGESTS,
    });
    const confirmed = makeTuple("v2");
    const { deps, state, started } = makeDeps(db, {
      listing: entriesFor(confirmed),
      startRunId: "run-w1",
      recheck: (_gw, _p, _f, approved) =>
        Promise.resolve({
          ok: true,
          tuple: confirmed,
          changes: diffSourceTuple(approved, confirmed),
        }),
    });

    await watchTick(deps, state);
    expect(started).toHaveLength(1);
    expect(getRun(db, "run-w1")?.status).toBe("running");

    await watchTick(deps, state);
    expect(state.lastResult).toBe("skipped_busy");
    expect(started).toHaveLength(1);
    expect(listWatchEvents(db, 10)).toHaveLength(2);
  });

  it("does not retry its own failed run for the same tuple", async () => {
    const db = openDb(":memory:");
    const old = makeTuple("v1");
    seedRun(db, {
      id: "run-latest",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "reviewable",
      sourceTuple: old,
      receipt: RECEIPT_WITH_DIGESTS,
    });
    const confirmed = makeTuple("v2");
    const { deps, state, started } = makeDeps(db, {
      listing: entriesFor(confirmed),
      startRunId: "run-w1",
      recheck: (_gw, _p, _f, approved) =>
        Promise.resolve({
          ok: true,
          tuple: confirmed,
          changes: diffSourceTuple(approved, confirmed),
        }),
    });

    await watchTick(deps, state);
    finishRun(db, "run-w1", "failed", "pipeline blew up");
    started[0]?.onFinish?.("failed");

    // The folder still shows v2, but the latest run already covers it.
    await watchTick(deps, state);
    expect(state.lastResult).toBe("no_change");
    expect(started).toHaveLength(1);
    expect(listWatchEvents(db, 10).map((e) => e.result)).toEqual([
      "run_failed",
      "run_started",
      "changed",
    ]);
    const failed = listWatchEvents(db, 10)[0];
    expect(failed?.detail_json).toContain("start a run manually");
    expect(failed?.run_id).toBe("run-w1");
  });

  it("records one deduped event when Box is unavailable", async () => {
    const db = openDb(":memory:");
    seedRun(db, {
      id: "run-latest",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "approved",
      sourceTuple: makeTuple("v1"),
    });
    const { deps, state } = makeDeps(db, {
      connections: () =>
        Promise.resolve([{ provider: "openrouter", gatewayBaseUrl: "http://or.test" }]),
    });

    await watchTick(deps, state);
    await watchTick(deps, state);

    expect(state.lastResult).toBe("box_unavailable");
    const events = listWatchEvents(db, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("unavailable");
    expect(events[0]?.detail_json).toContain("box connector");
  });
});

describe("startWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is disabled at interval 0 and ticks on schedule otherwise", async () => {
    vi.useFakeTimers();
    const db = openDb(":memory:");
    const tuple = makeTuple("v1");
    seedRun(db, {
      id: "run-latest",
      createdAt: "2026-11-25T02:00:00.000Z",
      status: "approved",
      sourceTuple: tuple,
    });
    const listing = vi.fn(() => Promise.resolve(entriesFor(tuple)));
    const base = makeDeps(db, { listFolderItems: listing });

    const disabled = startWatcher({ ...base.deps, intervalMs: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listing).not.toHaveBeenCalled();
    expect(disabled.state.lastCheckedAt).toBeNull();

    const watcher = startWatcher(base.deps);
    await vi.advanceTimersByTimeAsync(6_000); // first tick at ~5 s
    expect(listing).toHaveBeenCalledTimes(1);
    expect(watcher.state.lastResult).toBe("no_change");
    await vi.advanceTimersByTimeAsync(60_000); // then every interval
    expect(listing).toHaveBeenCalledTimes(2);
    watcher.stop();
  });
});
