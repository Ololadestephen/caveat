import { describe, expect, it } from "vitest";
import type { RunReceipt } from "./receipt.ts";
import { draftHash, renderDraft } from "./draft.ts";
import { fixtureReceipt } from "./fixture-receipt.ts";

const RECEIPT: RunReceipt = fixtureReceipt("run-20261124-120000-ab12");

describe("renderDraft", () => {
  it("is deterministic and ends with one LF", () => {
    const a = renderDraft(RECEIPT);
    const b = renderDraft(JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a).not.toContain("\r");
    expect(draftHash(a)).toBe(draftHash(b));
  });

  it("renders the full draft from the expected fixtures", () => {
    expect(renderDraft(RECEIPT)).toMatchSnapshot();
  });

  it("omits the first-amendment item for other cash effects", () => {
    const receipt = JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt;
    if (receipt.humanReview.status === "ok") {
      receipt.humanReview.review.firstAmendmentPay.cashEffectInWindow = "none";
    }
    const draft = renderDraft(receipt);
    expect(draft).not.toContain("First Amendment payment");
    expect(draft).not.toContain("4.");
  });
});

describe("renderDraft — counteroffer point", () => {
  const FOUND: RunReceipt["counteroffer"] = {
    status: "found",
    stopReason: "model_done",
    model: "m",
    best: "r1c1",
    humanReview: [],
    rounds: [
      {
        round: 1,
        modelNote: "n",
        done: true,
        candidates: [
          {
            id: "r1c1",
            lever: "upfront_deposit",
            params: { amount_cents: 800000, date: "2026-10-01", split_count: null, net_days: null },
            rationale: "x",
            status: "tested",
            rankCents: 800000,
            centDays: 74400000,
            summary:
              "pay $8,000 of the escrow funding to the consultant as cash at signing (modeled as Oct 1, 2026), reducing the Jan 2, 2027 release to $67,000",
            passesAll: true,
            perScenario: {
              retainer_superseded: {
                no_extensions: {
                  passes: true,
                  lowest: { date: "2026-12-15", balanceCents: 1000000 },
                  firstBreach: null,
                },
                all_extensions: {
                  passes: true,
                  lowest: { date: "2026-12-15", balanceCents: 1000000 },
                  firstBreach: null,
                },
              },
              retainer_continues: {
                no_extensions: {
                  passes: true,
                  lowest: { date: "2026-10-01", balanceCents: 2000000 },
                  firstBreach: null,
                },
                all_extensions: {
                  passes: true,
                  lowest: { date: "2026-10-01", balanceCents: 2000000 },
                  firstBreach: null,
                },
              },
            },
          },
        ],
      },
    ],
  };

  it("appends the tested proposal with runner-verified numbers", () => {
    const receipt = { ...JSON.parse(JSON.stringify(RECEIPT)), counteroffer: FOUND } as RunReceipt;
    const draft = renderDraft(receipt);
    expect(draft).toContain(
      "5. Proposed change, tested by Caveat: pay $8,000 of the escrow funding to the consultant as cash at signing (modeled as Oct 1, 2026), reducing the Jan 2, 2027 release to $67,000. This moves $8,000 earlier than the signed terms and adds no new money. Caveat's runner tested it against both extension cases under both retainer readings; cash stays at or above the $10,000 floor in all four (lowest $10,000 on December 15, 2026). It was found in round 1 of the search; the receipt lists every candidate tried.",
    );
  });

  it("appends the tested bound sentence when a bound exists", () => {
    const withBound = JSON.parse(JSON.stringify(FOUND)) as NonNullable<RunReceipt["counteroffer"]>;
    withBound.bound = { candidate: "r2c1", gap: { unit: "cents", value: 50000 } };
    withBound.rounds.push({
      round: 2,
      modelNote: "n",
      done: true,
      candidates: [
        {
          id: "r2c1",
          lever: "upfront_deposit",
          params: { amount_cents: 750000, date: "2026-10-01", split_count: null, net_days: null },
          rationale: "narrow it",
          status: "tested",
          rankCents: 750000,
          summary:
            "pay $7,500 of the escrow funding to the consultant as cash at signing (modeled as Oct 1, 2026), reducing the Jan 2, 2027 release to $67,500",
          passesAll: false,
        },
      ],
    });
    const receipt = { ...JSON.parse(JSON.stringify(RECEIPT)), counteroffer: withBound } as RunReceipt;
    const draft = renderDraft(receipt);
    expect(draft).toContain(
      "floor in all four (lowest $10,000 on December 15, 2026). A smaller version (pay $7,500 of the escrow funding to the consultant as cash at signing (modeled as Oct 1, 2026), reducing the Jan 2, 2027 release to $67,500) failed the same tests. It was found in round 1 of the search",
    );
  });

  it("says no tested change worked when the search found none", () => {
    const receipt = {
      ...JSON.parse(JSON.stringify(RECEIPT)),
      counteroffer: { ...FOUND, status: "not_found", best: null, rounds: FOUND.rounds },
    } as RunReceipt;
    const draft = renderDraft(receipt);
    expect(draft).toContain(
      "5. No tested change within 1 rounds kept cash at or above the floor in every scenario; the receipt lists every candidate tried.",
    );
  });

  it("omits the point when the search was not needed or absent", () => {
    const notNeeded = {
      ...JSON.parse(JSON.stringify(RECEIPT)),
      counteroffer: { ...FOUND, status: "not_needed", best: null, rounds: [] },
    } as RunReceipt;
    expect(renderDraft(notNeeded)).not.toContain("tested by Caveat");
    expect(renderDraft(notNeeded)).not.toContain("No tested change");
    // The v1 fixture has no counteroffer at all — no search wording either.
    expect(renderDraft(RECEIPT)).not.toContain("tested by Caveat");
  });
});

describe("owner cash file closing line", () => {
  it("names the file and its version tag", () => {
    const receipt = {
      ...JSON.parse(JSON.stringify(RECEIPT)),
      cashSource: {
        kind: "owner_file",
        fileName: "my-cash.csv",
        versionTag: "abc123def456",
        sha12: "000aaa111bbb",
      },
    } as RunReceipt;
    const draft = renderDraft(receipt);
    expect(draft).toContain(
      "Cash figures come from your file my-cash.csv (version abc123def456): opening cash $20,000 on October 1, 2026, cash floor $10,000, 6 costs totalling $36,000 from October 2026 to March 2027.",
    );
    expect(draft).toContain("(runner policy");
  });

  it("keeps the demo wording when no owner file was used", () => {
    const receipt = JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt;
    expect(renderDraft(receipt)).toContain(
      "Cash figures use demo assumptions, not facts about the parties:",
    );
  });
});

describe("invalid owner cash file closing line", () => {
  it("labels the file as unreadable with its detail", () => {
    const receipt = {
      ...JSON.parse(JSON.stringify(RECEIPT)),
      cashSource: {
        kind: "owner_file_invalid",
        fileName: "my-cash.csv",
        versionTag: "abc123def456",
        sha12: "000aaa111bbb",
        detail: "line 4: bad_amount: '6000.5' is not an amount like \"1234.56\"",
      },
    } as RunReceipt;
    expect(renderDraft(receipt)).toContain(
      "my-cash.csv (version abc123def456) could not be read: line 4: bad_amount: '6000.5' is not an amount like \"1234.56\". No cash results were produced until it is fixed.",
    );
  });
});

describe("renderDraft — your reply", () => {
  const META = {
    fileName: "04-client-reply.pdf",
    versionTag: "abc123def456",
    sha12: "000aaa111bbb",
  };
  const CITATION = {
    excerptId: "04-client-reply.pdf#§2",
    quote:
      "We propose that $3,000 of the escrow funding be paid to you as an upfront deposit on October 1, 2026",
    page: 1,
  };
  const SUMMARY =
    "pay $3,000 of the escrow funding to the consultant as cash at signing, reducing the Jan 2, 2027 release";
  const counter = (passesAll: boolean) => ({
    id: "client",
    lever: "upfront_deposit" as const,
    params: {
      amount_cents: 300000,
      date: "2026-10-01",
      split_count: null,
      net_days: null,
    },
    rationale: "client counter",
    status: "tested" as const,
    rankCents: 300000,
    summary: SUMMARY,
    passesAll,
    perScenario: {
      retainer_superseded: {
        no_extensions: {
          passes: passesAll,
          lowest: { date: "2026-12-15", balanceCents: passesAll ? 1100000 : 800000 },
          firstBreach: null,
        },
      },
    },
    workers: ["caveat-wa", "caveat-wb"],
  });

  it("safe: the reply block accepts the proposal as written", () => {
    const receipt = JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt;
    receipt.clientReply = {
      status: "safe",
      ...META,
      citation: CITATION,
      counter: counter(true),
      workers: ["caveat-wa", "caveat-wb"],
    };
    const draft = renderDraft(receipt);
    expect(draft).toContain(
      `Your reply (04-client-reply.pdf, version abc123def456): Your proposal (${SUMMARY}, quoted from your letter: "${CITATION.quote}") keeps our cash at or above the floor in every case we tested. We can accept it as written.`,
    );
    // The block sits immediately after the opening paragraph.
    expect(draft.indexOf("Your reply")).toBeLessThan(draft.indexOf("1. Escrow is not cash yet"));
  });

  it("countered: the reply block proposes the tested alternative", () => {
    const receipt = JSON.parse(JSON.stringify(RECEIPT)) as RunReceipt;
    const best = {
      id: "reply-r1c1",
      lever: "upfront_deposit" as const,
      params: { amount_cents: 600000, date: "2026-10-01", split_count: null, net_days: null },
      rationale: "bigger deposit",
      status: "tested" as const,
      rankCents: 600000,
      summary: "pay $6,000 of the escrow funding to the consultant as cash at signing",
      passesAll: true,
    };
    receipt.clientReply = {
      status: "countered",
      ...META,
      citation: CITATION,
      counter: counter(false),
      workers: ["caveat-wa", "caveat-wb"],
      response: {
        status: "found",
        stopReason: "model_done",
        model: "m",
        best: "reply-r1c1",
        humanReview: [],
        bound: { candidate: "client", gap: { unit: "cents", value: 300000 } },
        rounds: [{ round: 1, modelNote: "n", done: true, candidates: [best] }],
      },
    };
    const draft = renderDraft(receipt);
    // floor $10,000 minus failing low $8,000 = $2,000 under.
    expect(draft).toContain(
      `Your reply (04-client-reply.pdf, version abc123def456): Your proposal (${SUMMARY}) still leaves cash $2,000 under our floor on December 15, 2026. We propose instead: pay $6,000 of the escrow funding to the consultant as cash at signing.`,
    );
    expect(draft.indexOf("Your reply")).toBeLessThan(draft.indexOf("1. Escrow is not cash yet"));
  });

  it("no block at all without a reply", () => {
    expect(renderDraft(RECEIPT)).not.toContain("Your reply");
  });
});
