import { dayNumber, dateString } from "../runner/dates.ts";
import type { PaymentRule } from "../runner/types.ts";
import type { ValidatedPaymentTerms, ValidatedTerm } from "../interpret/payment-terms.ts";
import type { CashAssumptionsBase } from "./cash-file.ts";

export type TermsAssumptions = CashAssumptionsBase;

export type TermsReadingId = "partial_months_billed" | "partial_months_not_billed";

export const TERMS_READING_LABELS: Record<TermsReadingId, string> = {
  partial_months_billed: "Partial months billed",
  partial_months_not_billed: "Partial months not billed",
};

export type TermsBuildError = { reason: "unbuildable_terms"; detail: string };

function fail(detail: string): { ok: false; error: TermsBuildError } {
  return { ok: false, error: { reason: "unbuildable_terms", detail } };
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const ny = m === 12 ? (y ?? 0) + 1 : y;
  const nm = m === 12 ? 1 : (m ?? 1) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function lastDayOfMonth(ym: string): string {
  return dateString(dayNumber(nextMonth(ym) + "-01") - 1);
}

// The calendar months a reading invoices in: billed takes every month that
// overlaps the term; not_billed keeps only months wholly inside it.
export function invoiceMonths(
  reading: TermsReadingId,
  termStartIso: string,
  termEndIso: string,
): string[] {
  const months: string[] = [];
  for (let ym = termStartIso.slice(0, 7); ym <= termEndIso.slice(0, 7); ym = nextMonth(ym)) {
    if (reading === "partial_months_not_billed") {
      if (`${ym}-01` < termStartIso) continue;
      if (lastDayOfMonth(ym) > termEndIso) continue;
    }
    months.push(ym);
  }
  return months;
}

// The recurring monthly fee: a fixed_date_payment that recurs monthly with a
// parsed cash amount. Several parallel fees sum into one invoice amount.
function monthlyFeeCents(terms: ValidatedTerm[]): number | undefined {
  const fees = terms.filter(
    (t) => t.kind === "fixed_date_payment" && t.recurrence === "monthly" && t.amountCents !== null,
  );
  if (fees.length === 0) return undefined;
  return fees.reduce((sum, t) => sum + (t.amountCents ?? 0), 0);
}

// The invoice day-of-month rule: a term whose date parses to a day rule —
// month_end means the month's last day, month_day the stated day.
function invoiceDay(terms: ValidatedTerm[]): { day: number | "month_end" } | undefined {
  for (const t of terms) {
    if (t.date?.kind === "month_end") return { day: "month_end" };
    if (t.date?.kind === "month_day") return { day: t.date.day };
  }
  return undefined;
}

function invoiceDate(ym: string, rule: { day: number | "month_end" }): string {
  if (rule.day === "month_end") return lastDayOfMonth(ym);
  const last = lastDayOfMonth(ym);
  const day = Math.min(rule.day, Number(last.slice(8)));
  return `${ym}-${String(day).padStart(2, "0")}`;
}

// Builds the as-signed payment rules for one reading. Recurring fees expand
// into invoices on the reading's months; payment_terms turns each invoice into
// an on_acceptance rule, otherwise it is paid on the invoice date itself.
export function buildTermPaymentRules(
  terms: ValidatedPaymentTerms,
  reading: TermsReadingId,
): { ok: true; rules: PaymentRule[]; totalCents: number } | { ok: false; error: TermsBuildError } {
  const rules: PaymentRule[] = [];
  let totalCents = 0;
  const netDays =
    terms.terms.find((t) => t.kind === "payment_terms")?.netDays ?? undefined;

  const feeCents = monthlyFeeCents(terms.terms);
  if (feeCents !== undefined) {
    const day = invoiceDay(terms.terms);
    if (day === undefined) {
      return fail("a monthly fee is stated but no invoice day rule (e.g. last day of the month) was extracted");
    }
    if (terms.termStart === null || terms.termEnd === null) {
      return fail("a monthly fee is stated but the agreement term bounds are not");
    }
    for (const ym of invoiceMonths(reading, terms.termStart.iso, terms.termEnd.iso)) {
      const date = invoiceDate(ym, day);
      const base = { id: `invoice-${ym}`, amountCents: feeCents };
      rules.push(
        netDays === undefined
          ? { ...base, kind: "on_date", date }
          : {
              ...base,
              kind: "on_acceptance",
              deliveryDate: date,
              acceptanceWindowDays: 0,
              netDays,
            },
      );
      totalCents += feeCents;
    }
  }

  for (const t of terms.terms) {
    // The recurring fee and the payment_terms clause already fed the invoice
    // expansion; a recurring fixed_date_payment with no own concrete date is
    // part of that expansion too.
    if (t.kind === "payment_terms") continue;
    if (t.kind === "fixed_date_payment" && t.recurrence === "monthly") continue;
    if (t.kind === "fixed_date_payment" && t.date?.kind !== "date") continue;
    if (t.amountCents === null) continue;
    if (t.date === null || t.date.kind !== "date") {
      return fail(
        `${t.id} (${t.kind}) has no concrete calendar date to schedule on`,
      );
    }
    switch (t.kind) {
      case "fixed_date_payment":
      case "deposit":
        rules.push({ id: t.id, kind: "on_date", amountCents: t.amountCents, date: t.date.iso });
        totalCents += t.amountCents;
        break;
      case "escrow_release":
        // The money enters escrow and reaches the consultant on the date —
        // modelled as a deposit plus a release on the same day.
        rules.push(
          { id: `${t.id}-funding`, kind: "escrow_deposit", amountCents: t.amountCents, date: t.date.iso },
          { id: t.id, kind: "escrow_release", amountCents: t.amountCents, date: t.date.iso },
        );
        totalCents += t.amountCents;
        break;
    }
  }

  if (rules.length === 0) {
    return fail("the extracted terms produced no scheduled payments");
  }
  return { ok: true, rules, totalCents };
}

// The earliest date any reading pays cash in or out — the owner cash file's
// opening date must fall on or before it.
export function firstPaymentDate(terms: ValidatedPaymentTerms): string | undefined {
  let earliest: number | undefined;
  for (const reading of ["partial_months_billed", "partial_months_not_billed"] as const) {
    const built = buildTermPaymentRules(terms, reading);
    if (!built.ok) continue;
    for (const rule of built.rules) {
      const date =
        rule.kind === "on_acceptance" ? rule.deliveryDate : rule.date;
      const day = dayNumber(date);
      if (earliest === undefined || day < earliest) earliest = day;
    }
  }
  return earliest === undefined ? undefined : dateString(earliest);
}

function termsRunnerInput(args: {
  label: string;
  description: string;
  assumptions: TermsAssumptions;
  rules: PaymentRule[];
  totalCents: number;
}): Record<string, unknown> {
  // Normalized form: the coordinator digests the validated input while the
  // workers digest the raw one, so the raw input must already carry
  // validateRunInput's defaults (top-level assumptions, scenario fields).
  return {
    label: args.label,
    description: args.description,
    startDate: args.assumptions.startDate,
    openingCents: args.assumptions.openingCents,
    floorCents: args.assumptions.floorCents,
    costs: args.assumptions.costs,
    candidates: [
      { id: "as_signed", rankCents: 0, totalCents: args.totalCents, paymentRules: args.rules },
    ],
    scenarios: [
      { id: "on_time", acceptanceDelayDays: 0, paymentLagDays: 0, extraCosts: [], extensionsGranted: [] },
      { id: "paid_15_days_late", acceptanceDelayDays: 0, paymentLagDays: 15, extraCosts: [], extensionsGranted: [] },
    ],
    passingScenarios: ["on_time", "paid_15_days_late"],
  };
}

const READING_DESCRIPTIONS: Record<TermsReadingId, string> = {
  partial_months_billed:
    "an invoice on the last day of every calendar month that overlaps the term",
  partial_months_not_billed:
    "invoices only for calendar months wholly inside the term",
};

// Builds the two unresolved readings' runner inputs: the agreement does not
// say whether partial months are billed, so both readings run.
export function buildTermsReadings(args: {
  terms: ValidatedPaymentTerms;
  assumptions: TermsAssumptions;
  labelPrefix: string;
}): { ok: true; inputs: Record<TermsReadingId, Record<string, unknown>> } | { ok: false; error: TermsBuildError } {
  const inputs: Partial<Record<TermsReadingId, Record<string, unknown>>> = {};
  for (const reading of ["partial_months_billed", "partial_months_not_billed"] as const) {
    const built = buildTermPaymentRules(args.terms, reading);
    if (!built.ok) return built;
    inputs[reading] = termsRunnerInput({
      label: `${args.labelPrefix}-${reading}`,
      description: `${READING_DESCRIPTIONS[reading]} (one of two unresolved readings).`,
      assumptions: args.assumptions,
      rules: built.rules,
      totalCents: built.totalCents,
    });
  }
  return { ok: true, inputs: inputs as Record<TermsReadingId, Record<string, unknown>> };
}
