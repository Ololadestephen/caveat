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
