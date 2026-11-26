import { describe, expect, it } from "vitest";

import type { Excerpt } from "./types.ts";
import {
  parseNetDays,
  parseRecurrence,
  parseTermDate,
  validatePaymentTermsExtraction,
} from "./payment-terms.ts";

const E1 =
  "Terms of payment are net thirty (30) calendar days after receipt of a complete invoice.";
const E2 =
  "In consideration for the Services, Company shall pay Consultant $5,000.00 per month.";
const E3 =
  "Consultant shall invoice Company for the Fees on the last day of the invoiced month.";
const E4 =
  "Payments shall be paid net 30 days after the date of receipt of Consultant's invoice.";
const E5 =
  "The term of this Agreement will commence on May 29, 2024 and terminate four months later on September 29, 2024.";

function excerpts(): Excerpt[] {
  return [
    { id: "01.pdf#§2(a)", text: E1, source: { fileName: "01.pdf", versionLabel: "v", page: 1, section: "§2(a)" } },
    { id: "02.pdf#§3.1", text: E2, source: { fileName: "02.pdf", versionLabel: "v", page: 1, section: "§3.1" } },
    { id: "02.pdf#§3.2", text: E3, source: { fileName: "02.pdf", versionLabel: "v", page: 1, section: "§3.2" } },
    { id: "02.pdf#§3.3", text: E4, source: { fileName: "02.pdf", versionLabel: "v", page: 1, section: "§3.3" } },
    { id: "01.pdf#§9", text: E5, source: { fileName: "01.pdf", versionLabel: "v", page: 3, section: "§9" } },
  ];
}

// The four Aviat terms plus the term bounds, all verbatim.
function aviatParsed(): Record<string, unknown> {
  return {
    terms: [
      {
        kind: "payment_terms",
        amount_text: null,
        date_text: null,
        recurrence_text: null,
        net_days_text: "net thirty (30) calendar days",
        excerpt_id: "01.pdf#§2(a)",
        quote: "net thirty (30) calendar days after receipt",
        date_excerpt_id: null,
        date_quote: null,
      },
      {
        kind: "fixed_date_payment",
        amount_text: "$5,000.00",
        date_text: "per month",
        recurrence_text: null,
        net_days_text: null,
        excerpt_id: "02.pdf#§3.1",
        quote: "pay Consultant $5,000.00 per month.",
        date_excerpt_id: null,
        date_quote: null,
      },
      {
        kind: "fixed_date_payment",
        amount_text: "the Fees",
        date_text: "the last day of the invoiced month",
        recurrence_text: null,
        net_days_text: null,
        excerpt_id: "02.pdf#§3.2",
        quote: "invoice Company for the Fees on the last day of the invoiced month",
        date_excerpt_id: null,
        date_quote: null,
      },
      {
        kind: "payment_terms",
        amount_text: null,
        date_text: null,
        recurrence_text: null,
        net_days_text: "net 30 days",
        excerpt_id: "02.pdf#§3.3",
        quote: "net 30 days after the date",
        date_excerpt_id: null,
        date_quote: null,
      },
    ],
    term_start: { text: "May 29, 2024", excerpt_id: "01.pdf#§9", quote: "commence on May 29, 2024" },
    term_end: { text: "September 29, 2024", excerpt_id: "01.pdf#§9", quote: "September 29, 2024" },
    confidence: 0.9,
  };
}

describe("parseTermDate", () => {
  it("parses calendar dates and day-of-month rules", () => {
    expect(parseTermDate("May 29, 2024")).toMatchObject({ kind: "date", iso: "2024-05-29" });
    expect(parseTermDate("the last day of the invoiced month")).toEqual({ kind: "month_end" });
    expect(parseTermDate("the last day of each month")).toEqual({ kind: "month_end" });
    expect(parseTermDate("the first day of each month")).toEqual({ kind: "month_day", day: 1 });
    expect(parseTermDate("the 1st of the month")).toEqual({ kind: "month_day", day: 1 });
    expect(parseTermDate("whenever")).toBeUndefined();
  });
});

describe("parseRecurrence / parseNetDays", () => {
  it("maps monthly phrases and null to one-off", () => {
    expect(parseRecurrence("per month")).toBe("monthly");
    expect(parseRecurrence("Monthly")).toBe("monthly");
    expect(parseRecurrence("each month")).toBe("monthly");
    expect(parseRecurrence(null)).toBe("one_off");
    expect(parseRecurrence("annually")).toBeUndefined();
  });

  it("parses net-days phrasings within 1..120", () => {
    expect(parseNetDays("net 30 days")).toBe(30);
    expect(parseNetDays("net thirty (30) calendar days")).toBe(30);
    expect(parseNetDays("(15) days")).toBe(15);
    expect(parseNetDays("net 0 days")).toBeUndefined();
    expect(parseNetDays("net 365 days")).toBeUndefined();
    expect(parseNetDays("promptly")).toBeUndefined();
  });
});

describe("validatePaymentTermsExtraction", () => {
  it("accepts the Aviat term set and numbers terms in document order", () => {
    const out = validatePaymentTermsExtraction(aviatParsed(), excerpts(), 0.8);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.terms.terms.map((t) => t.id)).toEqual(["term-1", "term-2", "term-3", "term-4"]);
    const terms1 = out.terms.terms[0];
    const terms4 = out.terms.terms[3];
    expect(terms1?.kind).toBe("payment_terms");
    expect(terms1?.netDays).toBe(30);
    expect(terms4?.kind).toBe("payment_terms");
    expect(terms4?.netDays).toBe(30);
    const fee = out.terms.terms[1];
    expect(fee?.amountCents).toBe(500000);
    // "per month" sits in date_text; it validates as the recurrence.
    expect(fee?.recurrence).toBe("monthly");
    const invoice = out.terms.terms[2];
    expect(invoice?.date).toEqual({ kind: "month_end" });
    // "the Fees" is a named amount — verbatim, but no cents.
    expect(invoice?.amountText).toBe("the Fees");
    expect(invoice?.amountCents).toBeNull();
    expect(out.terms.termStart?.iso).toBe("2024-05-29");
    expect(out.terms.termEnd?.iso).toBe("2024-09-29");
  });

  it("accepts a split citation: the amount in one excerpt, its date rule in another", () => {
    const parsed = aviatParsed();
    const terms = parsed.terms as Record<string, unknown>[];
    // The §3.1 fee and the §3.2 invoice-day rule fold into one term.
    terms.splice(1, 2, {
      kind: "fixed_date_payment",
      amount_text: "$5,000.00",
      date_text: "the last day of the invoiced month",
      recurrence_text: "per month",
      net_days_text: null,
      excerpt_id: "02.pdf#§3.1",
      quote: "pay Consultant $5,000.00 per month.",
      date_excerpt_id: "02.pdf#§3.2",
      date_quote: "the Fees on the last day of the invoiced month",
    });
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const fee = out.terms.terms.find((t) => t.kind === "fixed_date_payment");
    expect(fee?.dateExcerptId).toBe("02.pdf#§3.2");
    expect(fee?.dateQuote).toBe("the Fees on the last day of the invoiced month");
    expect(fee?.date).toEqual({ kind: "month_end" });
    expect(fee?.recurrence).toBe("monthly");
  });

  it("rejects a date_text that is not verbatim within its date_quote", () => {
    const parsed = aviatParsed();
    const terms = parsed.terms as Record<string, unknown>[];
    terms.splice(1, 2, {
      kind: "fixed_date_payment",
      amount_text: "$5,000.00",
      date_text: "monthly",
      recurrence_text: "per month",
      net_days_text: null,
      excerpt_id: "02.pdf#§3.1",
      quote: "pay Consultant $5,000.00 per month.",
      date_excerpt_id: "02.pdf#§3.2",
      date_quote: "the Fees on the last day of the invoiced month",
    });
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "quote_not_verbatim" });
  });

  it("rejects a date_quote that is not verbatim in its excerpt", () => {
    const parsed = aviatParsed();
    const terms = parsed.terms as Record<string, unknown>[];
    terms.splice(1, 2, {
      kind: "fixed_date_payment",
      amount_text: "$5,000.00",
      date_text: "the last day of the invoiced month",
      recurrence_text: "per month",
      net_days_text: null,
      excerpt_id: "02.pdf#§3.1",
      quote: "pay Consultant $5,000.00 per month.",
      date_excerpt_id: "02.pdf#§3.2",
      date_quote: "not in the excerpt at all",
    });
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "quote_not_verbatim" });
  });

  it("rejects date_* fields on payment_terms and unpaired split fields", () => {
    const parsed = aviatParsed();
    const terms = parsed.terms as Record<string, unknown>[];
    terms[0]!.date_excerpt_id = "02.pdf#§3.3";
    terms[0]!.date_quote = "net 30 days after";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "schema_mismatch" });

    const parsed2 = aviatParsed();
    const terms2 = parsed2.terms as Record<string, unknown>[];
    terms2[1]!.date_quote = "pay Consultant $5,000.00 per month.";
    const out2 = validatePaymentTermsExtraction(parsed2, excerpts(), 0.8);
    expect(out2).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });

  it("orders terms by document position, not array order", () => {
    const parsed = aviatParsed();
    const terms = parsed.terms as Record<string, unknown>[];
    // §3.3's payment_terms moved first in the array still lands after §2(a)'s.
    terms.unshift(terms.pop()!);
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.terms.terms[0]?.excerptId).toBe("01.pdf#§2(a)");
  });

  it("rejects an unknown excerpt id", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[])[0]!.excerpt_id = "nope.pdf#§1";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "unknown_excerpt" });
  });

  it("rejects a quote that is not verbatim in its excerpt", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[])[0]!.quote = "not in the excerpt";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "quote_not_verbatim" });
  });

  it("rejects a text field that is not verbatim within its quote", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[])[0]!.net_days_text = "net ninety days";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "quote_not_verbatim" });
  });

  it("rejects a field a kind does not use", () => {
    const parsed = aviatParsed();
    const t = (parsed.terms as Record<string, unknown>[])[0]!;
    t.amount_text = "net thirty";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });

  it("rejects a missing required field for a kind", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[]).push({
      kind: "deposit",
      amount_text: null,
      date_text: "May 29, 2024",
      recurrence_text: null,
      net_days_text: null,
      excerpt_id: "01.pdf#§9",
      quote: "commence on May 29, 2024",
    });
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });

  it("rejects a fixed_date_payment carrying neither amount nor date", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[]).push({
      kind: "fixed_date_payment",
      amount_text: null,
      date_text: null,
      recurrence_text: null,
      net_days_text: null,
      excerpt_id: "01.pdf#§9",
      quote: "commence on May 29, 2024",
    });
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });

  it("rejects an unparseable amount on a cash-driving kind", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[]).push({
      kind: "escrow_release",
      amount_text: "Consultant",
      date_text: "May 29, 2024",
      recurrence_text: null,
      net_days_text: null,
      excerpt_id: "01.pdf#§9",
      quote: "pay Consultant on May 29, 2024",
    });
    // That quote is not verbatim, so check with a verbatim one instead.
    const t = (parsed.terms as Record<string, unknown>[]).at(-1) as Record<string, unknown>;
    t.quote = "commence on May 29, 2024";
    t.date_text = "May 29, 2024";
    t.amount_text = "May";
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });

  it("rejects disagreeing payment_terms as inconsistent_terms", () => {
    const parsed = aviatParsed();
    (parsed.terms as Record<string, unknown>[])[3]!.net_days_text = "(30) calendar";
    // Change §3.3's copy to a different N via a verbatim slice — "(30)" won't
    // do, so instead rewrite the term to cite §2(a) with a different phrase.
    const t = (parsed.terms as Record<string, unknown>[])[3]!;
    t.excerpt_id = "02.pdf#§3.3";
    t.quote = "net 30 days after";
    t.net_days_text = "net 30 days";
    // Same N still passes…
    expect(validatePaymentTermsExtraction(parsed, excerpts(), 0.8).ok).toBe(true);
    // …and a different N fails. There is no verbatim "net 45" in the excerpts,
    // so build the disagreement from a one-sided second excerpt.
    const ex = excerpts();
    ex.push({
      id: "02.pdf#§3.4",
      text: "Amounts are payable net 45 days from invoicing.",
      source: { fileName: "02.pdf", versionLabel: "v", page: 1, section: "§3.4" },
    });
    t.excerpt_id = "02.pdf#§3.4";
    t.quote = "net 45 days from invoicing";
    t.net_days_text = "net 45 days";
    const out = validatePaymentTermsExtraction(parsed, ex, 0.8);
    expect(out).toMatchObject({ ok: false, reason: "inconsistent_terms" });
  });

  it("rejects below-threshold confidence", () => {
    const parsed = { ...aviatParsed(), confidence: 0.5 };
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "low_confidence" });
  });

  it("requires term bounds for a recurring term", () => {
    const parsed = { ...aviatParsed(), term_start: null };
    const out = validatePaymentTermsExtraction(parsed, excerpts(), 0.8);
    expect(out).toMatchObject({ ok: false, reason: "missing_term_bounds" });
  });

  it("rejects a malformed term entry and bad top-level shape", () => {
    const parsed = aviatParsed();
    (parsed.terms as unknown[]).push({ kind: "deposit" });
    expect(validatePaymentTermsExtraction(parsed, excerpts(), 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
    expect(validatePaymentTermsExtraction("x", excerpts(), 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
    expect(validatePaymentTermsExtraction({ terms: [] }, excerpts(), 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
  });

  it("rejects a bad bound date and a bound quote not in its excerpt", () => {
    const bad = aviatParsed();
    bad.term_start = { text: "soon", excerpt_id: "01.pdf#§9", quote: "commence on May 29, 2024" };
    expect(validatePaymentTermsExtraction(bad, excerpts(), 0.8)).toMatchObject({
      ok: false,
      reason: "quote_not_verbatim",
    });
    const bad2 = aviatParsed();
    bad2.term_start = { text: "May 29, 2024", excerpt_id: "01.pdf#§9", quote: "commence on May 29, 2024" };
    bad2.term_end = { text: "eventually", excerpt_id: "01.pdf#§9", quote: "September 29, 2024" };
    const out = validatePaymentTermsExtraction(bad2, excerpts(), 0.8);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/quote_not_verbatim|schema_mismatch/);
  });
});
