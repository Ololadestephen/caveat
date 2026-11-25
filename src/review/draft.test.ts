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
