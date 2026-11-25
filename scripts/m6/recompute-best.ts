// Independent recompute for the m6 proof: takes a run receipt JSON plus the
// private reviewer file, rebuilds the best candidate's worker inputs exactly
// as the search loop built them, runs the local runner, and compares the
// resultDigests. Prints JSON {candidate, readings, expected, match}.
// Usage: node scripts/m6/recompute-best.ts <receipt.json> <retainer-review.json>
import { readFileSync } from "node:fs";

import { buildTwinveeInputs, escrowRules } from "../../src/plan/twinvee.ts";
import type { TwinveeAssumptions } from "../../src/plan/twinvee.ts";
import type { RetainerReview } from "../../src/review/human-review.ts";
import { runFixture } from "../../src/runner/run.ts";
import { buildSearchBase, compileCandidate } from "../../src/search/levers.ts";
import type { ProposedCandidate } from "../../src/search/levers.ts";
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
  counteroffer?: { best: string | null; rounds: { candidates: SearchCandidateRecord[] }[] };
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
const record = r.counteroffer?.rounds
  .flatMap((round) => round.candidates)
  .find((c) => c.id === bestId);
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
const proposal: ProposedCandidate = {
  lever: record.lever,
  amount_cents: record.params.amount_cents,
  date: record.params.date,
  split_count: record.params.split_count,
  net_days: record.params.net_days,
  rationale: record.rationale,
};
const compiled = compileCandidate(base, proposal);
if (!compiled.ok) {
  console.error(`candidate ${bestId} no longer compiles: ${compiled.code} ${compiled.detail}`);
  process.exit(1);
}

const escrowIds = new Set(base.rules.map((rule) => rule.id));
const built = buildTwinveeInputs({ schedule, review, assumptions });

const digests: Record<string, string> = {};
for (const [readingId, rawInput] of Object.entries(built)) {
  const asSigned = (
    rawInput as { candidates?: { rankCents: number; totalCents: number; paymentRules: { id: string }[] }[] }
  ).candidates?.[0];
  const nonEscrow = (asSigned?.paymentRules ?? []).filter((rule) => !escrowIds.has(rule.id));
  const input = {
    ...rawInput,
    candidates: [
      {
        id: record.id,
        rankCents: compiled.rankCents,
        totalCents: asSigned?.totalCents ?? 0,
        paymentRules: [...compiled.escrowRules, ...nonEscrow],
      },
    ],
  };
  digests[readingId] = runFixture(input).resultDigest;
}

const expected = record.resultDigests;
const match =
  Object.keys(expected).length === Object.keys(digests).length &&
  Object.entries(expected).every(([readingId, digest]) => digests[readingId] === digest);
console.log(JSON.stringify({ candidate: bestId, readings: digests, expected, match }, null, 2));
process.exit(match ? 0 : 1);
