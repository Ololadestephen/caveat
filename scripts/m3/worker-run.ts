import { readFileSync } from "node:fs";

import { runFixture } from "../../src/runner/run.ts";

// Merges a candidate-less fixture bundle with an overlay carrying the
// candidates, runs the deterministic runner, and prints the digests plus a
// per-scenario verdict summary. Usage:
//   node worker-run.ts <bundle.json> <overlay.json>
const [bundlePath, overlayPath] = process.argv.slice(2);
if (bundlePath === undefined || overlayPath === undefined) {
  console.error("usage: node worker-run.ts <bundle.json> <overlay.json>");
  process.exit(2);
}

const bundle: unknown = JSON.parse(readFileSync(bundlePath, "utf8"));
const overlay: unknown = JSON.parse(readFileSync(overlayPath, "utf8"));
const candidates =
  typeof overlay === "object" && overlay !== null
    ? (overlay as { candidates?: unknown }).candidates
    : undefined;
if (typeof bundle !== "object" || bundle === null || !Array.isArray(candidates)) {
  console.error("bundle must be an object and overlay must carry a candidates array");
  process.exit(2);
}

const merged = { ...bundle, candidates };
const out = runFixture(merged);

const verdicts: Record<string, Record<string, string>> = {};
for (const [candidateId, scenarios] of Object.entries(out.results)) {
  verdicts[candidateId] = {};
  for (const [scenarioId, result] of Object.entries(scenarios)) {
    verdicts[candidateId][scenarioId] = result.passes ? "pass" : "fail";
  }
}

console.log(
  JSON.stringify({
    runnerVersion: out.runnerVersion,
    inputDigest: out.inputDigest,
    resultDigest: out.resultDigest,
    smallestPassingCandidate: out.smallestPassingCandidate,
    verdicts,
  }),
);
