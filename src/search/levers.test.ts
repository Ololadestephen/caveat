import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture } from "../runner/run.ts";
import type { ScenarioResult } from "../runner/types.ts";
import type { PaymentRule } from "../runner/types.ts";
import type { ValidatedSchedule } from "../interpret/schedule.ts";
import type { RetainerReview } from "../review/human-review.ts";
import { buildTwinveeInputs, escrowRules } from "../plan/twinvee.ts";
import type { TwinveeAssumptions } from "../plan/twinvee.ts";
import { buildSearchBase, compileCandidate } from "./levers.ts";
import { digestValue } from "../runner/digest.ts";
import type { ProposedCandidate, SearchBase } from "./levers.ts";

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const ASSUMPTIONS = loadJson(
  "../../fixtures/plan/twinvee-demo-assumptions.json",
) as TwinveeAssumptions;

// The same stubbed §3 extraction the twinvee tests use: $25,000/month for a
// 6-month period; $75,000 unconditional release on 2027-01-02 plus three
// conditional $25,000 releases.
const EXTRACTION: ValidatedSchedule = {
  monthlyAmountText: "$25,000",
  monthlyAmountCents: 2500000,
  monthlyExcerptId: "03-second-amendment.pdf#§3(a)",
  monthlyQuote: "The Company shall pay Consultant $25,000 per month.",
  periodText: "6-month",
  periodMonths: 6,
  periodExcerptId: "03-second-amendment.pdf#§3(b)",
  periodQuote: "escrow for the 6-month period",
  releases: [
    {
      id: "release-1",
      conditional: false,
      extensionId: undefined,
      amountText: "$75,000",
      amountCents: 7500000,
      dateText: "January 2, 2027",
      date: "2027-01-02",
      conditionText: null,
      excerptId: "03-second-amendment.pdf#§3(b)(i)",
      quote: "$75,000 shall be paid to Consultant on January 2, 2027",
    },
    {
      id: "release-ext-1",
      conditional: true,
      extensionId: "ext-2027-01-31",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "January 2, 2027",
      date: "2027-01-02",
      conditionText: "until January 31, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(ii)",
      quote: "$25,000 shall be paid to Consultant on January 2, 2027",
    },
    {
      id: "release-ext-2",
      conditional: true,
      extensionId: "ext-2027-02-28",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "February 2, 2027",
      date: "2027-02-02",
      conditionText: "until February 28, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(iii)",
      quote: "$25,000 shall be paid to Consultant on February 2, 2027",
    },
    {
      id: "release-ext-3",
      conditional: true,
      extensionId: "ext-2027-03-31",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "March 2, 2027",
      date: "2027-03-02",
      conditionText: "until March 31, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(iv)",
      quote: "$25,000 shall be paid to Consultant on March 2, 2027",
    },
  ],
  confidence: 0.9,
};

const REVIEW: RetainerReview = {
  questionId: "retainer_after_second_amendment",
  reviewer: "Ololade Stephen",
  reviewedAt: "2026-11-24",
  revision: 2,
  revisionNote: "Corrects revision 1.",
  baseRetainer: {
    answer: "unresolved_compare_both",
    note: "Reviewer chose not to resolve; show both readings side by side.",
    citations: [],
    continuesReading: {
      amount: {
        text: "$6,000 per month",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.3",
        quote: "a rate of $6,000 per month",
      },
      payDay: {
        text: "on the 1st of each month",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.4",
        quote: "on the 1st of each month",
      },
      termEnd: {
        text: "December 31, 2026",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.5",
        quote: "expire on December 31, 2026",
      },
    },
  },
  firstAmendmentPay: {
    answer: "continues",
    cashEffectInWindow: "none",
    note: "Both payments are due by September 30, 2026 at the latest.",
    citations: [],
  },
};

const ESCROW_IDS = new Set(
  escrowRules(EXTRACTION, ASSUMPTIONS.escrowFundingDate).map((r) => r.id),
);

const BASE = buildSearchBase(
  EXTRACTION,
  escrowRules(EXTRACTION, ASSUMPTIONS.escrowFundingDate),
  ASSUMPTIONS.escrowFundingDate,
);

const INPUTS = buildTwinveeInputs({
  schedule: EXTRACTION,
  review: REVIEW,
  assumptions: ASSUMPTIONS,
});

function proposal(overrides: Partial<ProposedCandidate>): ProposedCandidate {
  return {
    lever: "earlier_release",
    amount_cents: null,
    date: null,
    split_count: null,
    net_days: null,
    rationale: "test",
    ...overrides,
  };
}

// Runs one compiled candidate through the real runner on both readings, the
// same job shape the loop hands workers.
function runCompiled(
  escrow: PaymentRule[],
  rankCents: number,
): Record<string, Record<string, ScenarioResult>> {
  const out: Record<string, Record<string, ScenarioResult>> = {};
  for (const [readingId, raw] of Object.entries(INPUTS)) {
    const input = JSON.parse(JSON.stringify(raw)) as {
      candidates: { id: string; rankCents: number; totalCents: number; paymentRules: PaymentRule[] }[];
    };
    const asSigned = input.candidates[0]!;
    const nonEscrow = asSigned.paymentRules.filter((r) => !ESCROW_IDS.has(r.id));
    const candidateInput = {
      ...input,
      candidates: [
        {
          id: "c",
          rankCents,
          totalCents: asSigned.totalCents,
          paymentRules: [...escrow, ...nonEscrow],
        },
      ],
    };
    out[readingId] = runFixture(candidateInput).results["c"]!;
  }
  return out;
}

function passesAll(results: Record<string, Record<string, ScenarioResult>>): boolean {
  return Object.values(results).every((scenarios) =>
    Object.values(scenarios).every((r) => r.passes),
  );
}

describe("compileCandidate — field rules", () => {
  it("rejects a required field left null", () => {
    const result = compileCandidate(BASE, proposal({ lever: "upfront_deposit", amount_cents: null, date: "2026-10-01" }));
    expect(result).toMatchObject({ ok: false, code: "missing_field", field: "amount_cents" });
  });

  it("rejects a field the lever does not take", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "upfront_deposit", amount_cents: 100000, date: "2026-10-01", split_count: 2 }),
    );
    expect(result).toMatchObject({ ok: false, code: "unexpected_field", field: "split_count" });
  });

  it("rejects amounts that are not positive multiples of 100 within the first release", () => {
    for (const bad of [150, -100, 0, 7500100, 1.5]) {
      const result = compileCandidate(
        BASE,
        proposal({ lever: "earlier_release", amount_cents: bad, date: "2026-11-13" }),
      );
      expect(result).toMatchObject({ ok: false, code: "invalid_amount", field: "amount_cents" });
    }
  });

  it("rejects non-civil dates", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "tomorrow"]) {
      const result = compileCandidate(
        BASE,
        proposal({ lever: "earlier_release", amount_cents: 100000, date: bad }),
      );
      expect(result).toMatchObject({ ok: false, code: "invalid_date", field: "date" });
    }
  });

  it("rejects a deposit on any date other than the funding date", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "upfront_deposit", amount_cents: 800000, date: "2026-10-02" }),
    );
    expect(result).toMatchObject({ ok: false, code: "deposit_date", field: "date" });
  });

  it("rejects an early release outside [funding, r1)", () => {
    for (const bad of ["2026-09-30", "2027-01-02", "2027-01-03"]) {
      const result = compileCandidate(
        BASE,
        proposal({ lever: "earlier_release", amount_cents: 800000, date: bad }),
      );
      expect(result).toMatchObject({ ok: false, code: "release_window", field: "date" });
    }
  });

  it("rejects split counts outside {2,3}", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-11-13", split_count: 4 }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_split_count", field: "split_count" });
  });

  it("rejects a split amount that is not whole dollars", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800050, date: "2026-11-13", split_count: 2 }),
    );
    expect(result).toMatchObject({ ok: false, code: "split_not_whole_dollars", field: "amount_cents" });
  });

  it("rejects a first split date after the 28th", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-11-30", split_count: 2 }),
    );
    expect(result).toMatchObject({ ok: false, code: "split_day_of_month", field: "date" });
  });

  it("rejects a split whose parts leave the release window", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-12-05", split_count: 2 }),
    );
    expect(result).toMatchObject({ ok: false, code: "split_out_of_range", field: "date" });
  });

  it("rejects net_days outside [0,60]", () => {
    for (const bad of [-1, 61, 1.5]) {
      const result = compileCandidate(BASE, proposal({ lever: "shorter_payment_terms", net_days: bad }));
      expect(result).toMatchObject({ ok: false, code: "invalid_net_days", field: "net_days" });
    }
  });

  it("marks shorter_payment_terms lever_not_applicable when the release is not whole months", () => {
    const oddSchedule: ValidatedSchedule = {
      ...EXTRACTION,
      releases: [{ ...EXTRACTION.releases[0]!, amountCents: 7500100 }, ...EXTRACTION.releases.slice(1)],
    };
    const base = buildSearchBase(
      oddSchedule,
      escrowRules(oddSchedule, ASSUMPTIONS.escrowFundingDate),
      ASSUMPTIONS.escrowFundingDate,
    );
    expect(base.monthsCovered).toBeNull();
    const result = compileCandidate(base, proposal({ lever: "shorter_payment_terms", net_days: 13 }));
    expect(result).toMatchObject({ ok: false, code: "lever_not_applicable", field: "net_days" });
  });

  it("reports no_change when no month moves before the first release", () => {
    // A one-month base funded December: Dec 31 + 5 days lands after Jan 2, so
    // nothing leaves release-1.
    const base: SearchBase = {
      fundingDate: "2026-12-01",
      fundingAmountCents: 2500000,
      r1Id: "release-1",
      r1AmountCents: 2500000,
      r1Date: "2027-01-02",
      monthlyCents: 2500000,
      monthsCovered: 1,
      coveredMonths: ["2026-12"],
      rules: [
        { id: "escrow-funding", kind: "escrow_deposit", amountCents: 2500000, date: "2026-12-01" },
        { id: "release-1", kind: "escrow_release", amountCents: 2500000, date: "2027-01-02" },
      ],
    };
    const result = compileCandidate(base, proposal({ lever: "shorter_payment_terms", net_days: 5 }));
    expect(result).toMatchObject({ ok: false, code: "no_change", field: "net_days" });
  });

  it("rejects an empty or overlong rationale", () => {
    for (const bad of ["", "x".repeat(301)]) {
      const result = compileCandidate(
        BASE,
        proposal({ lever: "earlier_release", amount_cents: 100000, date: "2026-11-13", rationale: bad }),
      );
      expect(result).toMatchObject({ ok: false, code: "bad_rationale", field: "rationale" });
    }
  });

  it("rejects an unknown lever", () => {
    const result = compileCandidate(BASE, proposal({ lever: "magic" as never }));
    expect(result).toMatchObject({ ok: false, code: "unknown_lever", field: "lever" });
  });
});

describe("compileCandidate — compiled rules and summaries", () => {
  it("upfront_deposit shrinks funding and release-1 and adds an on_date deposit", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "upfront_deposit", amount_cents: 800000, date: "2026-10-01" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const funding = result.escrowRules.find((r) => r.id === "escrow-funding");
    const deposit = result.escrowRules.find((r) => r.id === "deposit");
    const r1 = result.escrowRules.find((r) => r.id === "release-1");
    expect(funding).toMatchObject({ kind: "escrow_deposit", amountCents: 14200000 });
    expect(deposit).toMatchObject({ kind: "on_date", amountCents: 800000, date: "2026-10-01" });
    expect(r1).toMatchObject({ kind: "escrow_release", amountCents: 6700000 });
    expect(result.rankCents).toBe(800000);
    // Oct 1 2026 -> Jan 2 2027 is 93 days.
    expect(result.centDays).toBe(800000 * 93);
    expect(result.summary).toBe(
      "pay $8,000 of the escrow funding to the consultant as cash at signing (modeled as Oct 1, 2026), reducing the Jan 2, 2027 release to $67,000",
    );
  });

  it("earlier_release carves an escrow_release and shrinks release-1", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const early = result.escrowRules.find((r) => r.id === "early-release");
    const r1 = result.escrowRules.find((r) => r.id === "release-1");
    expect(early).toMatchObject({ kind: "escrow_release", amountCents: 800000, date: "2026-11-13" });
    expect(r1).toMatchObject({ amountCents: 6700000 });
    expect(result.summary).toBe(
      "release $8,000 of the Jan 2, 2027 escrow payment on Nov 13, 2026, reducing that release to $67,000",
    );
  });

  it("milestone_split emits N equal monthly parts", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-11-13", split_count: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escrowRules.find((r) => r.id === "split-1")).toMatchObject({ amountCents: 400000, date: "2026-11-13" });
    expect(result.escrowRules.find((r) => r.id === "split-2")).toMatchObject({ amountCents: 400000, date: "2026-12-13" });
    expect(result.summary).toBe(
      "release $8,000 of the Jan 2, 2027 escrow payment in 2 monthly parts of $4,000 from Nov 13, 2026, reducing that release to $67,000",
    );
    // Even splits are byte-identical to the pre-whole-dollar implementation;
    // the digest was computed at HEAD for the baseline's best candidate
    // (milestone_split 800000/2 from 2026-10-02).
    const baseline = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-10-02", split_count: 2 }),
    );
    if (!baseline.ok) throw new Error("baseline compile failed");
    expect(digestValue(baseline.escrowRules)).toBe(
      "63ab7b06b59649ad02d47f4633e868f13768a1e9b3f1e0899fa08595e9257f13",
    );
  });

  it("milestone_split gives the earliest parts the extra whole dollars", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 799900, date: "2026-10-02", split_count: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escrowRules.find((r) => r.id === "split-1")).toMatchObject({ amountCents: 400000, date: "2026-10-02" });
    expect(result.escrowRules.find((r) => r.id === "split-2")).toMatchObject({ amountCents: 399900, date: "2026-11-02" });
    expect(result.summary).toBe(
      "release $7,999 of the Jan 2, 2027 escrow payment in 2 monthly parts ($4,000, $3,999) from Oct 2, 2026, reducing that release to $67,001",
    );
  });

  it("milestone_split spreads the extra dollars across three parts", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-10-02", split_count: 3 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.escrowRules.find((r) => r.id === "split-1")).toMatchObject({ amountCents: 266700, date: "2026-10-02" });
    expect(result.escrowRules.find((r) => r.id === "split-2")).toMatchObject({ amountCents: 266700, date: "2026-11-02" });
    expect(result.escrowRules.find((r) => r.id === "split-3")).toMatchObject({ amountCents: 266600, date: "2026-12-02" });
    expect(result.summary).toBe(
      "release $8,000 of the Jan 2, 2027 escrow payment in 3 monthly parts ($2,667, $2,667, $2,666) from Oct 2, 2026, reducing that release to $67,000",
    );
  });

  it("shorter_payment_terms moves covered months that land before release-1", () => {
    const result = compileCandidate(BASE, proposal({ lever: "shorter_payment_terms", net_days: 13 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Oct 31 + 13 = Nov 13; Nov 30 + 13 = Dec 13; Dec 31 + 13 = Jan 13 stays.
    expect(result.escrowRules.find((r) => r.id === "terms-2026-10")).toMatchObject({ amountCents: 2500000, date: "2026-11-13" });
    expect(result.escrowRules.find((r) => r.id === "terms-2026-11")).toMatchObject({ amountCents: 2500000, date: "2026-12-13" });
    expect(result.escrowRules.find((r) => r.id === "terms-2026-12")).toBeUndefined();
    expect(result.escrowRules.find((r) => r.id === "release-1")).toMatchObject({ amountCents: 2500000 });
    expect(result.rankCents).toBe(5000000);
    expect(result.summary).toBe(
      "release each month's $25,000 of the Jan 2, 2027 escrow payment 13 days after the month ends (Nov 13, 2026; Dec 13, 2026), reducing that release to $25,000",
    );
  });

  it("keeps conditional releases and the funding rule untouched", () => {
    const result = compileCandidate(
      BASE,
      proposal({ lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of ["release-ext-1", "release-ext-2", "release-ext-3"]) {
      expect(result.escrowRules.find((r) => r.id === id)).toMatchObject({ amountCents: 2500000 });
    }
    expect(result.escrowRules.find((r) => r.id === "escrow-funding")).toMatchObject({ amountCents: 15000000 });
  });
});

// The hand-checked expectations from the spec — through the real runner on
// both readings (four scenario checks each).
describe("compileCandidate — runner verdicts", () => {
  function verdicts(p: ProposedCandidate): Record<string, Record<string, ScenarioResult>> {
    const compiled = compileCandidate(BASE, p);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("compile failed");
    return runCompiled(compiled.escrowRules, compiled.rankCents);
  }

  it("upfront_deposit $8,000 passes all four; lowest $10,000 on Dec 15", () => {
    const results = verdicts(proposal({ lever: "upfront_deposit", amount_cents: 800000, date: "2026-10-01" }));
    expect(passesAll(results)).toBe(true);
    expect(results["retainer_superseded"]?.["no_extensions"]?.lowest).toEqual({
      date: "2026-12-15",
      balanceCents: 1000000,
    });
  });

  it("upfront_deposit $7,900 fails; lowest $9,900 on Dec 15", () => {
    const results = verdicts(proposal({ lever: "upfront_deposit", amount_cents: 790000, date: "2026-10-01" }));
    expect(passesAll(results)).toBe(false);
    expect(results["retainer_superseded"]?.["no_extensions"]?.lowest).toEqual({
      date: "2026-12-15",
      balanceCents: 990000,
    });
  });

  it("earlier_release $8,000 on Nov 13 passes all four", () => {
    const results = verdicts(proposal({ lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" }));
    expect(passesAll(results)).toBe(true);
  });

  it("earlier_release $8,000 on Nov 14 (Sat) fails — received Mon, breaches Nov 15", () => {
    const results = verdicts(proposal({ lever: "earlier_release", amount_cents: 800000, date: "2026-11-14" }));
    expect(passesAll(results)).toBe(false);
    expect(results["retainer_superseded"]?.["no_extensions"]?.firstBreach).toMatchObject({
      date: "2026-11-15",
      balanceCents: 800000,
    });
  });

  it("milestone_split $8,000 in two parts from Nov 13 passes; lowest $10,000 on Dec 15", () => {
    const results = verdicts(
      proposal({ lever: "milestone_split", amount_cents: 800000, date: "2026-11-13", split_count: 2 }),
    );
    expect(passesAll(results)).toBe(true);
    expect(results["retainer_superseded"]?.["no_extensions"]?.lowest).toEqual({
      date: "2026-12-15",
      balanceCents: 1000000,
    });
  });

  it("milestone_split $7,999 in two whole-dollar parts fails; lowest under the floor", () => {
    const results = verdicts(
      proposal({ lever: "milestone_split", amount_cents: 799900, date: "2026-10-02", split_count: 2 }),
    );
    expect(passesAll(results)).toBe(false);
    expect(
      results["retainer_superseded"]?.["no_extensions"]?.lowest?.balanceCents,
    ).toBeLessThan(1000000);
  });

  it("shorter_payment_terms net 13 passes; net 14 breaches Nov 15", () => {
    const pass = verdicts(proposal({ lever: "shorter_payment_terms", net_days: 13 }));
    expect(passesAll(pass)).toBe(true);
    const fail = verdicts(proposal({ lever: "shorter_payment_terms", net_days: 14 }));
    expect(passesAll(fail)).toBe(false);
    expect(fail["retainer_superseded"]?.["no_extensions"]?.firstBreach).toMatchObject({
      date: "2026-11-15",
      balanceCents: 800000,
    });
  });
});
