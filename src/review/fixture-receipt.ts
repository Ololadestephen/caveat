import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ScenarioResult } from "../runner/types.ts";
import type { RunReceipt } from "./receipt.ts";

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const SUPERSEDED = loadJson("../../fixtures/runner/twinvee-escrow.expected.json") as {
  results: Record<string, Record<string, ScenarioResult>>;
  smallestPassingCandidate: string | null;
};
const CONTINUES = loadJson(
  "../../fixtures/runner/twinvee-escrow-retainer-continues.expected.json",
) as {
  results: Record<string, Record<string, ScenarioResult>>;
  smallestPassingCandidate: string | null;
};
const ASSUMPTIONS = loadJson(
  "../../fixtures/plan/twinvee-demo-assumptions.json",
) as RunReceipt["assumptions"];

// A fixed receipt whose results come from the authoritative expected files.
export function fixtureReceipt(runId: string): RunReceipt {
  return {
    receiptVersion: "caveat-receipt/1",
    runId,
    status: "reviewable",
    blockedReasons: [],
    questionIds: ["release_timing", "retainer_after_second_amendment"],
    sources: [
      {
        fileName: "01-consulting-agreement.pdf",
        versionLabel: "sha256 860043ebb685",
        versionPresent: true,
        edgarUrl: null,
      },
      {
        fileName: "02-first-amendment.pdf",
        versionLabel: "sha256 b0ebd4e2f98f",
        versionPresent: true,
        edgarUrl: null,
      },
      {
        fileName: "03-second-amendment.pdf",
        versionLabel: "sha256 a36ff3a50c18",
        versionPresent: true,
        edgarUrl: null,
      },
    ],
    releaseTiming: {
      outcome: {
        status: "decided",
        provider: "openrouter",
        model: "test-model",
        latencyMs: 1,
        decision: {
          action: "escrow_release",
          reason: "ignored",
          cited_clause: { excerpt_id: "x", quote: "ignored" },
          confidence: 1,
        },
      },
      question: {
        spec: { id: "release_timing", questionText: "", actions: [] },
        id: "release_timing",
        excerpts: [],
      },
    },
    effectiveAction: "escrow_release",
    overrides: [],
    schedule: {
      outcome: {
        status: "extracted",
        provider: "openrouter",
        model: "test-model",
        latencyMs: 1,
        schedule: {
          monthlyAmountText: "$25,000",
          monthlyAmountCents: 2500000,
          monthlyExcerptId: "03-second-amendment.pdf#§3(a)",
          monthlyQuote: "$25,000 per month",
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
              excerptId: "x",
              quote: "q",
            },
          ],
          confidence: 1,
        },
      },
      excerpts: [],
    },
    humanReview: {
      status: "ok",
      review: {
        questionId: "retainer_after_second_amendment",
        reviewer: "Ololade Stephen",
        reviewedAt: "2026-11-24",
        revision: 2,
        revisionNote: "note",
        baseRetainer: {
          answer: "unresolved_compare_both",
          note: undefined,
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
          cashEffectInWindow: "none_modeled",
          note: undefined,
          citations: [],
        },
      },
    },
    flags: [
      {
        kind: "date_range_inverted",
        fileName: "03-second-amendment.pdf",
        sectionId: "§3(c)",
        quote: "from December 31, 2026 until March 31, 2026",
        startDate: "2026-12-31",
        endDate: "2026-03-31",
      },
    ],
    readings: [
      {
        id: "retainer_superseded",
        label: "Retainer superseded",
        inputDigest: "a".repeat(64),
        resultDigest: "b".repeat(64),
        smallestPassingCandidate: SUPERSEDED.smallestPassingCandidate,
        results: SUPERSEDED.results,
        adjustments: [
          {
            scenarioId: "all_extensions",
            adjustments: [
              {
                ruleId: "release-1",
                contractDate: "2027-01-02",
                modeledDate: "2027-01-04",
                policy: "weekend_to_next_business_day",
              },
            ],
          },
        ],
      },
      {
        id: "retainer_continues",
        label: "Retainer continues",
        inputDigest: "c".repeat(64),
        resultDigest: "d".repeat(64),
        smallestPassingCandidate: CONTINUES.smallestPassingCandidate,
        results: CONTINUES.results,
        adjustments: [],
      },
    ],
    assumptions: ASSUMPTIONS,
  };
}
