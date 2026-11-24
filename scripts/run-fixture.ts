import { readFileSync } from "node:fs";
import { runFixture } from "../src/runner/run.ts";
import type { ScenarioResult } from "../src/runner/types.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run fixture -- <fixture.json>");
  process.exit(2);
}

const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
const out = runFixture(raw);
const label = (raw as { label?: string }).label;

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const line = (r: ScenarioResult): string => {
  const verdict = r.passes ? "pass" : "FAIL";
  const breach = r.firstBreach
    ? `first breach ${r.firstBreach.date} wk${r.firstBreach.week} at ${money(r.firstBreach.balanceCents)}`
    : "no breach";
  return `${verdict.padEnd(4)}  ${breach} | low ${money(r.lowest.balanceCents)} on ${r.lowest.date} | end ${money(r.endBalanceCents)} cash, ${money(r.endEscrowCents)} escrow`;
};

console.log(`${label ?? "fixture"} — runner ${out.runnerVersion}`);
console.log(`inputDigest  ${out.inputDigest}`);
console.log(`resultDigest ${out.resultDigest}`);
for (const [candidateId, perScenario] of Object.entries(out.results)) {
  console.log(`\n${candidateId}`);
  for (const [scenarioId, result] of Object.entries(perScenario)) {
    console.log(`  ${scenarioId.padEnd(22)} ${line(result)}`);
  }
}
console.log(`\nsmallest passing candidate: ${out.smallestPassingCandidate ?? "none"}`);
