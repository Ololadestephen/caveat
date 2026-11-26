import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_PROFILES } from "../contracts/profiles.ts";
import { listWatchEvents, openDb } from "../store/db.ts";
import { startWatcher } from "../watch/watcher.ts";
import type { Watcher } from "../watch/watcher.ts";
import { createAppContext, serveContext, startRun } from "./app.ts";
import type { WatcherView } from "./pages.ts";

const dataDir = process.env.CAVEAT_DATA_DIR ?? "/home/sprite/caveat-data";
const db = openDb(join(dataDir, "caveat.db"));
const boxFolder = process.env.CAVEAT_BOX_FOLDER ?? "caveat_TEST";
// Every profile's folder is ticked; the twinvee folder stays env-settable.
const contracts = CONTRACT_PROFILES.map((p) => ({
  id: p.id,
  boxFolder: p.id === "twinvee" ? boxFolder : p.boxFolder,
}));
const watchIntervalMs = envNumber("CAVEAT_WATCH_INTERVAL_MS", 60000);

let revision = "unknown";
try {
  revision = readFileSync("REVISION", "utf8").trim() || "unknown";
} catch {
  // REVISION is written at deploy time; absent in local dev/tests.
}

const watcherRef: { current?: Watcher } = {};
const ctx = createAppContext({
  db,
  approver: process.env.CAVEAT_APPROVER,
  revision,
  reviewsDir: process.env.CAVEAT_REVIEWS_DIR ?? join(dataDir, "reviews"),
  fixturesDir: process.env.CAVEAT_FIXTURES_DIR ?? "fixtures",
  boxFolder,
  decisionModel: process.env.CAVEAT_DECISION_MODEL,
  runTimeoutMs: envNumber("CAVEAT_RUN_TIMEOUT_MS", 1200000),
  recheckTimeoutMs: envNumber("CAVEAT_RECHECK_TIMEOUT_MS", 30000),
  watcher: (): WatcherView => ({
    enabled: watchIntervalMs > 0,
    intervalMs: watchIntervalMs,
    folders: contracts.map((c) => ({ contract: c.id, boxFolder: c.boxFolder })),
    lastCheckedAt: watcherRef.current?.state.lastCheckedAt ?? null,
    results: Object.fromEntries(
      contracts.map((c) => [c.id, watcherRef.current?.state.results[c.id] ?? null]),
    ),
    events: listWatchEvents(db, 5),
  }),
});
const server = serveContext(ctx);

// Polls the Box folder and starts incremental reruns on change; disabled when
// CAVEAT_WATCH_INTERVAL_MS is 0. Never uploads or writes to Box.
watcherRef.current = startWatcher({
  db,
  contracts,
  intervalMs: watchIntervalMs,
  startRun: (args) => startRun(ctx, args),
});

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const port = envNumber("PORT", 8080);
server.listen(port, () => {
  console.log(`caveat listening on :${port} (data ${dataDir}, revision ${revision})`);
});
