import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "../store/db.ts";
import { createApp } from "./app.ts";

const dataDir = process.env.CAVEAT_DATA_DIR ?? "/home/sprite/caveat-data";
const db = openDb(join(dataDir, "caveat.db"));

let revision = "unknown";
try {
  revision = readFileSync("REVISION", "utf8").trim() || "unknown";
} catch {
  // REVISION is written at deploy time; absent in local dev/tests.
}

const server = createApp({
  db,
  approver: process.env.CAVEAT_APPROVER,
  revision,
  reviewsDir: process.env.CAVEAT_REVIEWS_DIR ?? join(dataDir, "reviews"),
  fixturesDir: process.env.CAVEAT_FIXTURES_DIR ?? "fixtures",
  boxFolder: process.env.CAVEAT_BOX_FOLDER ?? "caveat_TEST",
  decisionModel: process.env.CAVEAT_DECISION_MODEL,
  runTimeoutMs: envNumber("CAVEAT_RUN_TIMEOUT_MS", 300000),
  recheckTimeoutMs: envNumber("CAVEAT_RECHECK_TIMEOUT_MS", 30000),
});

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const port = envNumber("PORT", 8080);
server.listen(port, () => {
  console.log(`caveat listening on :${port} (data ${dataDir}, revision ${revision})`);
});
