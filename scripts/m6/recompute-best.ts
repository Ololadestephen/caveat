// Independent recompute for the m6 proof: takes a run receipt JSON plus the
// private reviewer file, rebuilds the best candidate's worker inputs exactly
// as the search loop built them, runs the local runner, and compares the
// resultDigests. When the receipt carries a bound, the bound candidate is
// recomputed too and must fail locally. Prints JSON
// {candidate, readings, expected, match, bound}.
// Usage: node scripts/m6/recompute-best.ts <receipt.json> <retainer-review.json>
import { readFileSync } from "node:fs";

import { buildTwinveeInputs, escrowRules } from "../../src/plan/twinvee.ts";
import type { TwinveeAssumptions } from "../../src/plan/twinvee.ts";
import type { RetainerReview } from "../../src/review/human-review.ts";
import { runFixture } from "../../src/runner/run.ts";
import type { RunOutput } from "../../src/runner/types.ts";
import { buildSearchBase, compileCandidate } from "../../src/search/levers.ts";
import type { ProposedCandidate, SearchBase } from "../../src/search/levers.ts";
import type { SearchCandidateRecord } from "../../src/search/loop.ts";
import type { ValidatedSchedule } from "../../src/interpret/schedule.ts";

const [receiptPath, reviewPath] = process.argv.slice(2);
if (receiptPath === undefined || reviewPath === undefined) {
  console.error("usage: recompute-best.ts <receipt.json> <retainer-review.json>");
  process.exit(2);
}

const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
const review = JSON.parse(readFileSync(reviewPath, "utf8")) as RetainerReview;

type Receipt = {
  assumptions: TwinveeAssumptions;
  schedule: { outcome: { status: string; schedule?: ValidatedSchedule } } | null;
  counteroffer?: {
    best: string | null;
    bound?: { candidate: string } | null;
    rounds: { candidates: SearchCandidateRecord[] }[];
  };
};
const r = receipt as Receipt;

const schedule = r.schedule?.outcome.status === "extracted" ? r.schedule.outcome.schedule : undefined;
if (schedule === undefined) {
  console.error("receipt schedule outcome is not extracted");
  process.exit(1);
}
const bestId = r.counteroffer?.best;
if (bestId === undefined || bestId === null) {
  console.error("receipt counteroffer.best is null");
  process.exit(1);
}
const allCandidates = r.counteroffer?.rounds.flatMap((round) => round.candidates) ?? [];
const record = allCandidates.find((c) => c.id === bestId);
if (record === undefined) {
  console.error(`no candidate record ${bestId} in the receipt rounds`);
  process.exit(1);
}
if (record.resultDigests === undefined) {
  console.error(`candidate ${bestId} has no resultDigests`);
  process.exit(1);
}

const assumptions = r.assumptions;
const base = buildSearchBase(
  schedule,
  escrowRules(schedule, assumptions.escrowFundingDate),
  assumptions.escrowFundingDate,
);
const escrowIds = new Set(base.rules.map((rule) => rule.id));
const built = buildTwinveeInputs({ schedule, review, assumptions });

type CandidateInput = {
  candidates?: { rankCents: number; totalCents: number; paymentRules: { id: string }[] }[];
};

// Rebuild one candidate's per-reading job inputs exactly as the loop did, run
// the local runner, and report digests plus the passesAll verdict.
function recompute(
  base: SearchBase,
  candidate: SearchCandidateRecord,
): { digests: Record<string, string>; passesAll: boolean; outputs: Record<string, RunOutput> } {
  const proposal: ProposedCandidate = {
    lever: candidate.lever,
    amount_cents: candidate.params.amount_cents,
    date: candidate.params.date,
    split_count: candidate.params.split_count,
    net_days: candidate.params.net_days,
    rationale: candidate.rationale,
  };
  const compiled = compileCandidate(base, proposal);
  if (!compiled.ok) {
    throw new Error(`candidate ${candidate.id} no longer compiles: ${compiled.code} ${compiled.detail}`);
  }
  const digests: Record<string, string> = {};
  const outputs: Record<string, RunOutput> = {};
  let passesAll = true;
  for (const [readingId, rawInput] of Object.entries(built)) {
    const asSigned = (rawInput as CandidateInput).candidates?.[0];
    const nonEscrow = (asSigned?.paymentRules ?? []).filter((rule) => !escrowIds.has(rule.id));
    const input = {
      ...rawInput,
      candidates: [
        {
          id: candidate.id,
          rankCents: compiled.rankCents,
          totalCents: asSigned?.totalCents ?? 0,
          paymentRules: [...compiled.escrowRules, ...nonEscrow],
        },
      ],
    };
    const output = runFixture(input);
    outputs[readingId] = output;
    digests[readingId] = output.resultDigest;
    const scenarios = (rawInput as { scenarios?: { id: string }[] }).scenarios ?? [];
    for (const scen of scenarios) {
      if (output.results[candidate.id]?.[scen.id]?.passes !== true) passesAll = false;
    }
  }
  return { digests, passesAll, outputs };
}

function digestsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) => b[k] === v)
  );
}

let failed = false;
const bestRun = recompute(base, record);
const match = digestsEqual(record.resultDigests, bestRun.digests);
if (!match) failed = true;

const boundId = r.counteroffer?.bound?.candidate;
let boundReport: { candidate: string; match: boolean; passesAll: boolean } | null = null;
if (typeof boundId === "string") {
  const boundRecord = allCandidates.find((c) => c.id === boundId);
  if (boundRecord === undefined || boundRecord.resultDigests === undefined) {
    console.error(`bound candidate ${boundId} missing or has no resultDigests`);
    process.exit(1);
  }
  const boundRun = recompute(base, boundRecord);
  boundReport = {
    candidate: boundId,
    match: digestsEqual(boundRecord.resultDigests, boundRun.digests),
    passesAll: boundRun.passesAll,
  };
  if (!boundReport.match || boundReport.passesAll !== false) failed = true;
}

console.log(
  JSON.stringify(
    {
      candidate: bestId,
      readings: bestRun.digests,
      expected: record.resultDigests,
      match,
      bound: boundReport,
    },
    null,
    2,
  ),
);
process.exit(failed ? 1 : 0);
