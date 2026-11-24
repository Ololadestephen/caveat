import { describe, expect, it } from "vitest";
import type { RunReceipt } from "./receipt.ts";
import { renderReviewPage } from "./review-page.ts";

const DECIDED_OUTCOME = {
  status: "decided" as const,
  provider: "openrouter",
  model: "nvidia/nemotron-3.5-super-vl:free",
  modelVersion: "nvidia/nemotron-3.5-super-vl:free",
  servedBy: "Nvidia",
  latencyMs: 9000,
  decision: {
    action: "escrow_release",
    reason: "The amendment pays the monthly amounts into escrow; the consultant is paid only on the stated release dates.",
    cited_clause: {
      excerpt_id: "03-second-amendment.pdf#§3(a)",
      quote: "paid to Consultant upon release from escrow",
    },
    confidence: 0.92,
  },
};

const EXCERPTS = [
  {
    id: "03-second-amendment.pdf#§3(a)",
    text: "excerpt text",
    source: {
      fileName: "03-second-amendment.pdf",
      versionLabel: "sha256 a36ff3a50c18",
      page: 2,
      section: "§3(a)",
    },
  },
];

function scenarioResult(over: Partial<{
  passes: boolean;
  firstBreach: { date: string; week: number; balanceCents: number } | null;
  lowDate: string;
  lowCents: number;
  endCash: number;
  endEscrow: number;
}> = {}) {
  return {
    passes: over.passes ?? true,
    firstBreach: over.firstBreach ?? null,
    lowest: { date: over.lowDate ?? "2026-10-01", balanceCents: over.lowCents ?? 2000000 },
    endBalanceCents: over.endCash ?? 7700000,
    endEscrowCents: over.endEscrow ?? 7500000,
    ledger: [],
  };
}

const RECEIPT: RunReceipt = {
  receiptVersion: "caveat-receipt/1",
  runId: "m3-20261124T120000",
  status: "reviewable",
  blockedReasons: [],
  questionIds: ["release_timing", "retainer_after_second_amendment"],
  sources: [
    {
      fileName: "01-consulting-agreement.pdf",
      versionLabel: "sha256 860043ebb685",
      versionPresent: true,
      edgarUrl: "https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm",
    },
    {
      fileName: "03-second-amendment.pdf",
      versionLabel: "sha256 a36ff3a50c18",
      versionPresent: true,
      edgarUrl: "https://www.sec.gov/Archives/edgar/data/1855509/000173112226001331/e8000_ex10-1.htm",
    },
  ],
  releaseTiming: {
    outcome: DECIDED_OUTCOME,
    question: {
      spec: {
        id: "release_timing",
        questionText: "…",
        actions: ["cash_on_fixed_date", "escrow_release", "transaction_triggered", "ambiguous"],
      },
      id: "release_timing",
      excerpts: EXCERPTS,
    },
  },
  effectiveAction: "escrow_release",
  overrides: [],
  schedule: {
    outcome: {
      status: "extracted",
      provider: "openrouter",
      model: "nvidia/nemotron-3.5-super-vl:free",
      latencyMs: 12000,
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
            excerptId: "03-second-amendment.pdf#§3(a)",
            quote: "$75,000 on January 2, 2027",
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
            excerptId: "03-second-amendment.pdf#§3(a)",
            quote: "$25,000 if the Closing has not occurred until January 31, 2027",
          },
        ],
        confidence: 0.9,
      },
    },
    excerpts: EXCERPTS,
  },
  humanReview: {
    status: "ok",
    review: {
      questionId: "retainer_after_second_amendment",
      reviewer: "Ololade Stephen",
      reviewedAt: "2026-11-24",
      revision: 2,
      revisionNote: "Corrects revision 1.",
      baseRetainer: {
        answer: "unresolved_compare_both",
        note: undefined,
        citations: [
          {
            fileName: "03-second-amendment.pdf",
            section: "§3(a)",
            quote: "in lieu of all other compensation",
          },
        ],
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
        note: undefined,
        citations: [
          {
            fileName: "02-first-amendment.pdf",
            section: "§3(b)",
            quote: "$25,000 upon signing",
          },
        ],
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
      inputDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resultDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      smallestPassingCandidate: null,
      results: {
        as_signed: {
          no_extensions: scenarioResult({
            passes: false,
            firstBreach: { date: "2026-11-15", week: 7, balanceCents: 800000 },
            lowCents: 200000,
            lowDate: "2026-12-15",
            endCash: 5900000,
          }),
        },
      },
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
      inputDigest: "cccccccccccccccccccccccccccccccc",
      resultDigest: "dddddddddddddddddddddddddddddddd",
      smallestPassingCandidate: "as_signed",
      results: {
        as_signed: { no_extensions: scenarioResult() },
      },
      adjustments: [
        {
          scenarioId: "no_extensions",
          adjustments: [
            {
              ruleId: "retainer-2026-11",
              contractDate: "2026-11-01",
              modeledDate: "2026-11-02",
              policy: "weekend_to_next_business_day",
            },
          ],
        },
      ],
    },
  ],
  assumptions: {
    note: "Demo assumptions, not facts about the parties",
    startDate: "2026-10-01",
    escrowFundingDate: "2026-10-01",
    openingCents: 2000000,
    floorCents: 1000000,
    costs: [{ id: "cost-2026-10", date: "2026-10-15", amountCents: 600000 }],
  },
};

describe("renderReviewPage — reviewable run", () => {
  const html = renderReviewPage(RECEIPT);

  it("renders the seven sections in order", () => {
    const order = [
      "<h2>Sources</h2>",
      "<h2>Release timing</h2>",
      "<h2>Extracted escrow schedule</h2>",
      "<h2>Human review</h2>",
      "<h2>Flags</h2>",
      "<h2>Results</h2>",
      "<h2>Runner policy adjustments</h2>",
    ];
    let at = -1;
    for (const marker of order) {
      const found = html.indexOf(marker);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
  });

  it("lists sources with sha256 labels and EDGAR links", () => {
    expect(html).toContain("01-consulting-agreement.pdf");
    expect(html).toContain("sha256 860043ebb685");
    expect(html).toContain("e7774_ex10-1.htm");
    expect(html).toContain("e8000_ex10-1.htm");
  });

  it("renders the release_timing decision card", () => {
    expect(html).toContain("Escrow release");
    expect(html).toContain("paid to Consultant upon release from escrow");
    expect(html).toContain("model nvidia/nemotron-3.5-super-vl:free");
    expect(html).toContain("served by Nvidia");
    expect(html).toContain("self-reported confidence 0.92");
    expect(html).toContain("§3(a)");
  });

  it("renders the extracted schedule with verbatim quotes and sections", () => {
    expect(html).toContain("$25,000");
    expect(html).toContain("6-month");
    expect(html).toContain("release-1");
    expect(html).toContain("$75,000 on January 2, 2027");
    expect(html).toContain("until January 31, 2027");
  });

  it("renders the human review card for the unresolved retainer", () => {
    expect(html).toContain(
      "Retainer after the second amendment: unresolved, comparing both readings (reviewer Ololade Stephen, 2026-11-24, revision 2)",
    );
    expect(html).toContain("Revision note: Corrects revision 1.");
    expect(html).toContain("in lieu of all other compensation");
    expect(html).toContain("First-amendment pay: continues; no cash events in the modeled window");
    expect(html).toContain("$25,000 upon signing");
  });

  it("renders the inverted-date flag exactly as written", () => {
    expect(html).toContain(
      'Date conflict in 03-second-amendment.pdf §3(c): &ldquo;from December 31, 2026 until March 31, 2026&rdquo;. The end date is before the start date. Shown exactly as written; not corrected.',
    );
  });

  it("renders both readings side by side with scenario verdicts", () => {
    expect(html).toContain("Retainer superseded — as_signed");
    expect(html).toContain("Retainer continues — as_signed");
    expect(html).toContain("November 15, 2026 (week 7) at $8,000.00");
    expect(html).toContain("<td>fail</td>");
    expect(html).toContain("<td>pass</td>");
  });

  it("renders policy notes naming the contract date, weekday and modeled date", () => {
    expect(html).toContain("Contract date: January 2, 2027 (Saturday)");
    expect(html).toContain("Modeled receipt: Monday, January 4, 2027");
    expect(html).toContain("the contract says only January 2, 2027");
    expect(html).toContain("retainer-2026-11");
    expect(html).toContain("Contract date: November 1, 2026 (Sunday)");
    expect(html).toContain("Modeled receipt: Monday, November 2, 2026");
  });

  it("escapes HTML in rendered text", () => {
    const escaped: RunReceipt = JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt;
    escaped.flags[0]!.quote = 'from <script>alert("x")</script> until March 31, 2026';
    const out = renderReviewPage(escaped);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("renderReviewPage — blocked run", () => {
  const BLOCKED: RunReceipt = {
    ...RECEIPT,
    status: "needs_review",
    blockedReasons: [
      { reason: "unsupported_release_timing", detail: "release_timing decided transaction_triggered" },
    ],
    effectiveAction: "transaction_triggered",
    readings: [],
  };

  it("shows the blocking reason and no results", () => {
    const html = renderReviewPage(BLOCKED);
    expect(html).toContain("Blocked — this run needs human review");
    expect(html).toContain("unsupported_release_timing");
    expect(html).toContain("No results — this run needs review before results are produced");
    expect(html).not.toContain("Retainer superseded — as_signed");
    expect(html).not.toContain("Retainer continues — as_signed");
  });
});
