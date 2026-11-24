import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture } from "../runner/run.ts";
import { validateRunInput } from "../runner/validate.ts";
import type { ScenarioResult } from "../runner/types.ts";
import type { ValidatedSchedule } from "../interpret/schedule.ts";
import type { RetainerReview } from "../review/human-review.ts";
import { buildTwinveeInputs, policyAdjustments, PlanError } from "./twinvee.ts";
import type { TwinveeAssumptions } from "./twinvee.ts";

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const ASSUMPTIONS = loadJson("../../fixtures/plan/twinvee-demo-assumptions.json") as TwinveeAssumptions;

// A stubbed, valid extraction of the real second-amendment §3: $25,000/month
// for a 6-month period into escrow; $75,000 unconditional and three
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

describe("buildTwinveeInputs — gate tests", () => {
  const { retainer_superseded, retainer_continues } = buildTwinveeInputs({
    schedule: EXTRACTION,
    review: REVIEW,
    assumptions: ASSUMPTIONS,
  });

  it("the superseded reading reproduces the M2 expected results", () => {
    const expected = loadJson("../../fixtures/runner/twinvee-escrow.expected.json") as {
      results: Record<string, Record<string, ScenarioResult>>;
      smallestPassingCandidate: string | null;
    };
    const out = runFixture(retainer_superseded);
    expect(out.results).toEqual(expected.results);
    expect(out.smallestPassingCandidate).toBe(expected.smallestPassingCandidate);
  });

  it("the continues reading reproduces the retainer-continues expected results", () => {
    const expected = loadJson(
      "../../fixtures/runner/twinvee-escrow-retainer-continues.expected.json",
    ) as {
      results: Record<string, Record<string, ScenarioResult>>;
      smallestPassingCandidate: string | null;
    };
    const out = runFixture(retainer_continues);
    expect(out.results).toEqual(expected.results);
    expect(out.smallestPassingCandidate).toBe(expected.smallestPassingCandidate);
  });
});

describe("policyAdjustments", () => {
  const { retainer_continues } = buildTwinveeInputs({
    schedule: EXTRACTION,
    review: REVIEW,
    assumptions: ASSUMPTIONS,
  });
  const validated = validateRunInput(retainer_continues);

  it("reports the Saturday 2027-01-02 release as modeled on Monday 2027-01-04", () => {
    const scenario = validated.scenarios.find((s) => s.id === "all_extensions");
    expect(scenario).toBeDefined();
    const adjustments = policyAdjustments(validated, scenario!);
    expect(adjustments).toContainEqual({
      ruleId: "release-1",
      contractDate: "2027-01-02",
      modeledDate: "2027-01-04",
      policy: "weekend_to_next_business_day",
    });
    expect(adjustments).toContainEqual({
      ruleId: "release-ext-1",
      contractDate: "2027-01-02",
      modeledDate: "2027-01-04",
      policy: "weekend_to_next_business_day",
    });
  });

  it("reports the Sunday 2026-11-01 retainer payment as modeled on Monday 2026-11-02", () => {
    const scenario = validated.scenarios.find((s) => s.id === "no_extensions");
    const adjustments = policyAdjustments(validated, scenario!);
    expect(adjustments).toContainEqual({
      ruleId: "retainer-2026-11",
      contractDate: "2026-11-01",
      modeledDate: "2026-11-02",
      policy: "weekend_to_next_business_day",
    });
    expect(adjustments.map((a) => a.ruleId)).not.toContain("release-ext-1");
  });
});

describe("parse errors", () => {
  it("rejects a review without a continues reading", () => {
    const review = JSON.parse(JSON.stringify(REVIEW)) as RetainerReview;
    review.baseRetainer.continuesReading = undefined;
    expect(() =>
      buildTwinveeInputs({ schedule: EXTRACTION, review, assumptions: ASSUMPTIONS }),
    ).toThrow(PlanError);
  });
});
