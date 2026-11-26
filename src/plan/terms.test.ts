import { describe, expect, it } from "vitest";

import type { ValidatedPaymentTerms, ValidatedTerm } from "../interpret/payment-terms.ts";
import { runFixture } from "../runner/run.ts";
import { validateRunInput } from "../runner/validate.ts";
import { parseTermsCashFile } from "./cash-file.ts";
import {
  buildTermPaymentRules,
  buildTermsReadings,
  firstPaymentDate,
  invoiceMonths,
  proratedCents,
  TERMS_READING_LABELS,
} from "./terms.ts";
import type { TermsAssumptions } from "./terms.ts";

const ASSUMPTIONS: TermsAssumptions = {
  note: "demo",
  startDate: "2024-05-29",
  openingCents: 600000,
  floorCents: 200000,
  costs: [{ id: "cost-2024-06", date: "2024-06-15", amountCents: 400000 }],
};

function term(overrides: Partial<ValidatedTerm> & { id: string; kind: ValidatedTerm["kind"] }): ValidatedTerm {
  return {
    amountText: null,
    amountCents: null,
    dateText: null,
    date: null,
    recurrenceText: null,
    recurrence: "one_off",
    netDaysText: null,
    netDays: null,
    excerptId: "02-exhibit-a.pdf#§3",
    quote: "q",
    dateExcerptId: null,
    dateQuote: null,
    ...overrides,
  };
}

// The Aviat term set: monthly $5,000 fee, month-end invoicing, net 30, and a
// May 29 – Sep 29, 2024 term.
function aviatTerms(): ValidatedPaymentTerms {
  return {
    terms: [
      term({
        id: "term-1",
        kind: "fixed_date_payment",
        amountText: "$5,000.00",
        amountCents: 500000,
        dateText: "per month",
        recurrenceText: "per month",
        recurrence: "monthly",
      }),
      term({
        id: "term-2",
        kind: "fixed_date_payment",
        amountText: "the Fees",
        dateText: "the last day of the invoiced month",
        date: { kind: "month_end" },
      }),
      term({
        id: "term-3",
        kind: "payment_terms",
        netDaysText: "net 30 days",
        netDays: 30,
      }),
    ],
    termStart: {
      text: "May 29, 2024",
      iso: "2024-05-29",
      dayNum: 0,
      excerptId: "01-agreement.pdf#§9",
      quote: "commence on May 29, 2024",
    },
    termEnd: {
      text: "September 29, 2024",
      iso: "2024-09-29",
      dayNum: 0,
      excerptId: "01-agreement.pdf#§9",
      quote: "September 29, 2024",
    },
    confidence: 0.9,
  };
}

describe("proratedCents", () => {
  it("prorates the partial first and last months to whole dollars", () => {
    expect(proratedCents(500000, 3, 31)).toBe(48400); // May 2024: 3/31 → $484
    expect(proratedCents(500000, 29, 30)).toBe(483300); // Sep 2024: 29/30 → $4,833
  });

  it("leaves a full month unprorated", () => {
    expect(proratedCents(500000, 30, 30)).toBe(500000);
    expect(proratedCents(500000, 31, 31)).toBe(500000);
  });

  it("rounds to the nearest dollar, half up", () => {
    // $15.50 × 1/31 = $0.50 exactly → half up → $1.
    expect(proratedCents(1550, 1, 31)).toBe(100);
    // $15.20 × 1/31 = $0.49 → down → $0.
    expect(proratedCents(1520, 1, 31)).toBe(0);
    // $50,005 × 15/31 = $24,195.97 → $24,196.
    expect(proratedCents(5000500, 15, 31)).toBe(2419600);
  });
});

describe("reading labels", () => {
  it("shows the owner's pro-rata label on the page", () => {
    expect(TERMS_READING_LABELS.partial_months_prorated).toBe(
      "Partial months billed pro rata by calendar day (whole dollars) — owner's reading; the agreement does not say.",
    );
    expect(TERMS_READING_LABELS.partial_months_not_billed).toBe("Partial months not billed");
  });
});

describe("invoiceMonths", () => {
  it("billed covers every month overlapping the term", () => {
    expect(invoiceMonths("partial_months_prorated", "2024-05-29", "2024-09-29")).toEqual([
      "2024-05",
      "2024-06",
      "2024-07",
      "2024-08",
      "2024-09",
    ]);
  });

  it("not_billed keeps only months wholly inside the term", () => {
    expect(invoiceMonths("partial_months_not_billed", "2024-05-29", "2024-09-29")).toEqual([
      "2024-06",
      "2024-07",
      "2024-08",
    ]);
  });
});

describe("buildTermPaymentRules", () => {
  it("expands the recurring fee into month-end invoices with net-30 terms", () => {
    const built = buildTermPaymentRules(aviatTerms(), "partial_months_prorated");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.rules).toEqual([
      // May 29–31 is 3 of 31 days: 500000*3/31 = 48387.09…¢ → $484.
      { id: "invoice-2024-05", kind: "on_acceptance", amountCents: 48400, deliveryDate: "2024-05-31", acceptanceWindowDays: 0, netDays: 30 },
      { id: "invoice-2024-06", kind: "on_acceptance", amountCents: 500000, deliveryDate: "2024-06-30", acceptanceWindowDays: 0, netDays: 30 },
      { id: "invoice-2024-07", kind: "on_acceptance", amountCents: 500000, deliveryDate: "2024-07-31", acceptanceWindowDays: 0, netDays: 30 },
      { id: "invoice-2024-08", kind: "on_acceptance", amountCents: 500000, deliveryDate: "2024-08-31", acceptanceWindowDays: 0, netDays: 30 },
      // Sep 1–29 is 29 of 30 days: 500000*29/30 = 483333.33…¢ → $4,833.
      { id: "invoice-2024-09", kind: "on_acceptance", amountCents: 483300, deliveryDate: "2024-09-30", acceptanceWindowDays: 0, netDays: 30 },
    ]);
    expect(built.totalCents).toBe(2031700);
  });

  it("drops partial months in the not_billed reading", () => {
    const built = buildTermPaymentRules(aviatTerms(), "partial_months_not_billed");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.rules.map((r) => (r.kind === "on_acceptance" ? r.deliveryDate : ""))).toEqual([
      "2024-06-30",
      "2024-07-31",
      "2024-08-31",
    ]);
  });

  it("uses on_date invoices when no payment_terms term exists", () => {
    const terms = aviatTerms();
    terms.terms = terms.terms.filter((t) => t.kind !== "payment_terms");
    const built = buildTermPaymentRules(terms, "partial_months_not_billed");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.rules[0]).toEqual({
      id: "invoice-2024-06",
      kind: "on_date",
      amountCents: 500000,
      date: "2024-06-30",
    });
  });

  it("maps deposits to on_date and escrow releases to deposit+release", () => {
    const terms: ValidatedPaymentTerms = {
      terms: [
        term({
          id: "term-1",
          kind: "deposit",
          amountText: "$2,000",
          amountCents: 200000,
          dateText: "June 1, 2024",
          date: { kind: "date", iso: "2024-06-01", dayNum: 0 },
        }),
        term({
          id: "term-2",
          kind: "escrow_release",
          amountText: "$9,000",
          amountCents: 900000,
          dateText: "July 15, 2024",
          date: { kind: "date", iso: "2024-07-15", dayNum: 0 },
        }),
      ],
      termStart: null,
      termEnd: null,
      confidence: 0.9,
    };
    const built = buildTermPaymentRules(terms, "partial_months_prorated");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.rules).toEqual([
      { id: "term-1", kind: "on_date", amountCents: 200000, date: "2024-06-01" },
      { id: "term-2-funding", kind: "escrow_deposit", amountCents: 900000, date: "2024-07-15" },
      { id: "term-2", kind: "escrow_release", amountCents: 900000, date: "2024-07-15" },
    ]);
    expect(built.totalCents).toBe(1100000);
  });

  it("fails when a monthly fee has no invoice day rule or no terms build", () => {
    const noDay = aviatTerms();
    noDay.terms = noDay.terms.filter((t) => t.id !== "term-2");
    expect(buildTermPaymentRules(noDay, "partial_months_prorated")).toMatchObject({
      ok: false,
      error: { reason: "unbuildable_terms" },
    });
    const none = aviatTerms();
    none.terms = [none.terms[2]!];
    expect(buildTermPaymentRules(none, "partial_months_prorated")).toMatchObject({
      ok: false,
      error: { reason: "unbuildable_terms" },
    });
  });
});

describe("buildTermsReadings", () => {
  it("builds both readings with the on_time and 15-day-late scenarios", () => {
    const built = buildTermsReadings({
      terms: aviatTerms(),
      assumptions: ASSUMPTIONS,
      labelPrefix: "aviat-terms",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const reading of ["partial_months_prorated", "partial_months_not_billed"] as const) {
      const input = validateRunInput(built.inputs[reading]);
      expect(input.candidates).toHaveLength(1);
      expect(input.scenarios.map((s) => s.id)).toEqual(["on_time", "paid_15_days_late"]);
      expect(input.passingScenarios).toEqual(["on_time", "paid_15_days_late"]);
    }
  });

  it("acceptanceWindowDays 0 passes runner validation", () => {
    const built = buildTermsReadings({
      terms: aviatTerms(),
      assumptions: ASSUMPTIONS,
      labelPrefix: "aviat-terms",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const input = validateRunInput(built.inputs.partial_months_prorated);
    const rule = input.candidates[0]?.paymentRules[0];
    expect(rule?.kind).toBe("on_acceptance");
    if (rule?.kind !== "on_acceptance") return;
    expect(rule.acceptanceWindowDays).toBe(0);
  });
});

describe("runFixture on the built readings", () => {
  it("pays each month-end invoice 30 days later, weekends rolled", () => {
    const built = buildTermsReadings({
      terms: aviatTerms(),
      assumptions: ASSUMPTIONS,
      labelPrefix: "aviat-terms",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const out = runFixture(built.inputs.partial_months_prorated);
    const ledger = out.results.as_signed?.on_time?.ledger ?? [];
    const pays = ledger.filter((e) => e.kind === "payment").map((e) => `${e.id}@${e.date}`);
    expect(pays).toEqual([
      "invoice-2024-05@2024-07-01", // May 31 + 30d = Jun 30 Sun -> Jul 1
      "invoice-2024-06@2024-07-30",
      "invoice-2024-07@2024-08-30",
      "invoice-2024-08@2024-09-30",
      "invoice-2024-09@2024-10-30",
    ]);
  });

  it("shifts every pay date by 15 days under paid_15_days_late", () => {
    const built = buildTermsReadings({
      terms: aviatTerms(),
      assumptions: ASSUMPTIONS,
      labelPrefix: "aviat-terms",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const out = runFixture(built.inputs.partial_months_not_billed);
    const onTime = out.results.as_signed?.on_time?.ledger.filter((e) => e.kind === "payment") ?? [];
    const late = out.results.as_signed?.paid_15_days_late?.ledger.filter((e) => e.kind === "payment") ?? [];
    expect(late).toHaveLength(onTime.length);
    for (const [i, entry] of late.entries()) {
      expect(entry.date > onTime[i]!.date).toBe(true);
    }
  });
});

describe("firstPaymentDate", () => {
  it("is the earliest invoice delivery across readings", () => {
    expect(firstPaymentDate(aviatTerms())).toBe("2024-05-31");
  });
});

describe("parseTermsCashFile", () => {
  const CSV = [
    "kind,date,amount_usd",
    "opening,2024-05-29,6000.00",
    "floor,,2000.00",
    "cost,2024-06-15,4000.00",
  ].join("\n");

  it("parses opening on/before the first payment date", () => {
    const out = parseTermsCashFile(new TextEncoder().encode(CSV), "2024-05-31");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.assumptions.openingCents).toBe(600000);
    expect(out.assumptions.startDate).toBe("2024-05-29");
    expect("escrowFundingDate" in out.assumptions).toBe(false);
  });

  it("rejects an opening after the first payment date", () => {
    const out = parseTermsCashFile(new TextEncoder().encode(CSV), "2024-05-01");
    expect(out).toMatchObject({
      ok: false,
      code: "opening_after_funding",
    });
    if (out.ok) return;
    expect(out.detail).toContain("first payment date");
  });
});
