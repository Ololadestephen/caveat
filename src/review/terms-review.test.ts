import { describe, expect, it } from "vitest";

import type { ContractSection } from "../evidence/sections.ts";
import type { ValidatedTerm } from "../interpret/payment-terms.ts";
import { validateTermsReview } from "./terms-review.ts";

const sections: ContractSection[] = [
  {
    fileName: "02-exhibit-a.pdf",
    sectionId: "§3.3",
    title: "PRICE AND PAYMENT TERMS",
    text: "Payments shall be paid net 30 days after the date of receipt of Consultant's invoice.",
    pages: [1, 1] as [number, number],
  },
  {
    fileName: "02-exhibit-a.pdf",
    sectionId: "§3.1",
    title: "PRICE AND PAYMENT TERMS",
    text: "In consideration for the Services, Company shall pay Consultant $5,000.00 per month.",
    pages: [1, 1] as [number, number],
  },
] satisfies ContractSection[];

function term(id: string, quote: string, excerptId: string): ValidatedTerm {
  return {
    id,
    kind: "payment_terms",
    amountText: null,
    amountCents: null,
    dateText: null,
    date: null,
    recurrenceText: null,
    recurrence: "one_off",
    netDaysText: "net 30 days",
    netDays: 30,
    excerptId,
    quote,
  };
}

const T1 = term("term-1", "net 30 days after the date", "02-exhibit-a.pdf#§3.3");
const T2 = {
  ...term("term-2", "$5,000.00 per month", "02-exhibit-a.pdf#§3.1"),
  kind: "fixed_date_payment" as const,
  amountText: "$5,000.00",
  amountCents: 500000,
  netDaysText: null,
  netDays: null,
};

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "payment_terms",
    excerptId: "02-exhibit-a.pdf#§3.3",
    quote: "net 30 days after the date",
    decision: "confirm",
    reviewer: "owner",
    ...overrides,
  };
}

describe("validateTermsReview", () => {
  it("confirms every extracted term with a matching entry", () => {
    const out = validateTermsReview(
      { terms: [entry(), entry({ kind: "fixed_date_payment", excerptId: "02-exhibit-a.pdf#§3.1", quote: "$5,000.00 per month" })] },
      [T1, T2],
      sections,
    );
    expect(out.status).toBe("confirmed");
    if (out.status !== "confirmed") return;
    expect(out.decisions.map((d) => d.termId)).toEqual(["term-1", "term-2"]);
    expect(out.decisions[0]?.reviewer).toBe("owner");
    expect(out.extras).toEqual([]);
  });

  it("a missing entry blocks with terms_unconfirmed naming the term", () => {
    const out = validateTermsReview({ terms: [entry()] }, [T1, T2], sections);
    expect(out).toMatchObject({ status: "needs_review", reason: "terms_unconfirmed" });
    if (out.status !== "needs_review") return;
    expect(out.detail).toContain("term-2");
  });

  it("a matching reject blocks with term_rejected", () => {
    const out = validateTermsReview(
      { terms: [entry({ decision: "reject" })] },
      [T1],
      sections,
    );
    expect(out).toMatchObject({ status: "needs_review", reason: "term_rejected" });
  });

  it("extra entries are ignored but listed", () => {
    const out = validateTermsReview(
      { terms: [entry(), entry({ quote: "Consultant's invoice", decision: "reject" })] },
      [T1],
      sections,
    );
    // The second entry quotes the same section verbatim but its quote does not
    // match the extracted term's quote, so it is an extra — the reject does
    // not apply and the term still confirms.
    expect(out.status).toBe("confirmed");
    if (out.status !== "confirmed") return;
    expect(out.extras).toHaveLength(1);
    expect(out.extras[0]?.decision).toBe("reject");
  });

  it("a quote not verbatim in its section is review_citation_invalid", () => {
    const out = validateTermsReview(
      { terms: [entry({ quote: "net ninety days" })] },
      [T1],
      sections,
    );
    expect(out).toMatchObject({ status: "needs_review", reason: "review_citation_invalid" });
  });

  it("an unknown section is review_citation_invalid", () => {
    const out = validateTermsReview(
      { terms: [entry({ excerptId: "02-exhibit-a.pdf#§99" })] },
      [T1],
      sections,
    );
    expect(out).toMatchObject({ status: "needs_review", reason: "review_citation_invalid" });
  });

  it("malformed shapes are review_citation_invalid", () => {
    for (const raw of [
      "x",
      {},
      { terms: "x" },
      { terms: [{ kind: "bogus", excerptId: "a#b", quote: "q", decision: "confirm", reviewer: "r" }] },
      { terms: [entry({ decision: "maybe" })] },
      { terms: [entry({ reviewer: 3 })] },
    ]) {
      expect(validateTermsReview(raw, [T1], sections)).toMatchObject({
        status: "needs_review",
        reason: "review_citation_invalid",
      });
    }
  });
});
