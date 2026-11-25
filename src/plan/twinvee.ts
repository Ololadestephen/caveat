import { dayNumber, rollToBusinessDay, dateString } from "../runner/dates.ts";
import type { CostInput, PaymentRule, RunInput, Scenario } from "../runner/types.ts";
import { extractAmountCents } from "../interpret/schedule.ts";
import type { ValidatedSchedule } from "../interpret/schedule.ts";
import { parseMonthDayYear } from "../text.ts";
import type { RetainerReview } from "../review/human-review.ts";

export type TwinveeAssumptions = {
  note: string;
  startDate: string;
  escrowFundingDate: string;
  escrowFundingNote?: string;
  openingCents: number;
  floorCents: number;
  costs: CostInput[];
};

export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

const DAY_OF_MONTH_RE = /(\d{1,2})(?:st|nd|rd|th)/;

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

// Parse the reviewer's "continues" reading citations into schedule values:
// "$6,000 per month" -> 600000 cents, "on the 1st of each month" -> day 1,
// "December 31, 2026" -> the term-end month.
function parseRetainerReading(review: RetainerReview): {
  amountCents: number;
  dayOfMonth: number;
  termEndMonth: string;
} {
  const reading = review.baseRetainer.continuesReading;
  if (reading === undefined) {
    throw new PlanError(
      "missing_continues_reading",
      "the retainer review does not carry a continues reading",
    );
  }
  const amountCents = extractAmountCents(reading.amount.text);
  if (amountCents === undefined) {
    throw new PlanError(
      "retainer_amount_unparsed",
      `continues amount text ${JSON.stringify(reading.amount.text)} is not a dollar amount`,
    );
  }
  const day = DAY_OF_MONTH_RE.exec(reading.payDay.text);
  if (day === null) {
    throw new PlanError(
      "retainer_payday_unparsed",
      `continues pay-day text ${JSON.stringify(reading.payDay.text)} has no day of month`,
    );
  }
  const termEnd = parseMonthDayYear(reading.termEnd.text);
  if (termEnd === undefined) {
    throw new PlanError(
      "retainer_term_unparsed",
      `continues term-end text ${JSON.stringify(reading.termEnd.text)} is not a "Month D, YYYY" date`,
    );
  }
  return { amountCents, dayOfMonth: Number(day[1]), termEndMonth: monthKey(termEnd.iso) };
}

function retainerRules(args: {
  amountCents: number;
  dayOfMonth: number;
  firstMonth: string;
  lastMonth: string;
}): { rules: PaymentRule[]; totalCents: number } {
  const rules: PaymentRule[] = [];
  let total = 0;
  for (let month = args.firstMonth; month <= args.lastMonth; ) {
    const date = `${month}-${String(args.dayOfMonth).padStart(2, "0")}`;
    rules.push({ id: `retainer-${month}`, kind: "on_date", amountCents: args.amountCents, date });
    total += args.amountCents;
    const [y, m] = month.split("-").map(Number);
    const nextY = (m ?? 1) === 12 ? (y ?? 0) + 1 : (y ?? 0);
    const nextM = (m ?? 1) === 12 ? 1 : (m ?? 1) + 1;
    month = `${nextY}-${String(nextM).padStart(2, "0")}`;
  }
  return { rules, totalCents: total };
}

export function escrowRules(schedule: ValidatedSchedule, fundingDate: string): PaymentRule[] {
  const rules: PaymentRule[] = [
    {
      id: "escrow-funding",
      kind: "escrow_deposit",
      amountCents: schedule.monthlyAmountCents * schedule.periodMonths,
      date: fundingDate,
    },
  ];
  for (const release of schedule.releases) {
    const rule: PaymentRule = {
      id: release.id,
      kind: "escrow_release",
      amountCents: release.amountCents,
      date: release.date,
    };
    if (release.extensionId !== undefined) rule.requiresExtension = release.extensionId;
    rules.push(rule);
  }
  return rules;
}

function runnerInput(args: {
  label: string;
  description: string;
  assumptions: TwinveeAssumptions;
  rules: PaymentRule[];
  totalCents: number;
  extensionIds: string[];
}): Record<string, unknown> {
  return {
    label: args.label,
    description: args.description,
    startDate: args.assumptions.startDate,
    demoAssumptions: {
      note: args.assumptions.note,
      openingCents: args.assumptions.openingCents,
      floorCents: args.assumptions.floorCents,
      costs: args.assumptions.costs,
    },
    candidates: [
      { id: "as_signed", rankCents: 0, totalCents: args.totalCents, paymentRules: args.rules },
    ],
    scenarios: [
      { id: "no_extensions" },
      { id: "all_extensions", extensionsGranted: args.extensionIds },
    ],
    passingScenarios: ["no_extensions", "all_extensions"],
  };
}

// Builds the two runner inputs for the unresolved retainer reading:
// retainer_superseded models the escrow alone; retainer_continues adds the
// reviewer's sourced $/day/term-end retainer readings as on_date payments.
export function buildTwinveeInputs(args: {
  schedule: ValidatedSchedule;
  review: RetainerReview;
  assumptions: TwinveeAssumptions;
}): { retainer_superseded: Record<string, unknown>; retainer_continues: Record<string, unknown> } {
  const { schedule, review, assumptions } = args;
  const cashEffect = review.firstAmendmentPay.cashEffectInWindow;
  if (
    cashEffect !== undefined &&
    cashEffect !== "none" &&
    cashEffect !== "none_modeled"
  ) {
    throw new PlanError(
      "first_amendment_cash_unmodeled",
      `firstAmendmentPay.cashEffectInWindow is ${JSON.stringify(cashEffect)}; in-window first-amendment cash is not modeled`,
    );
  }
  const extensionIds = schedule.releases
    .map((r) => r.extensionId)
    .filter((id): id is string => id !== undefined);

  const superseded = runnerInput({
    label: "twinvee-escrow",
    description:
      "Escrow release reading of the second amendment; the base retainer is treated as superseded (one of two unresolved readings).",
    assumptions,
    rules: escrowRules(schedule, assumptions.escrowFundingDate),
    totalCents: schedule.monthlyAmountCents * schedule.periodMonths,
    extensionIds,
  });

  const retainer = parseRetainerReading(review);
  const monthly = retainerRules({
    amountCents: retainer.amountCents,
    dayOfMonth: retainer.dayOfMonth,
    firstMonth: monthKey(assumptions.startDate),
    lastMonth: retainer.termEndMonth,
  });
  const continues = runnerInput({
    label: "twinvee-escrow-retainer-continues",
    description:
      "Escrow release reading plus the base retainer continuing as written (the reviewer's alternative unresolved reading).",
    assumptions,
    rules: [...escrowRules(schedule, assumptions.escrowFundingDate), ...monthly.rules],
    totalCents: schedule.monthlyAmountCents * schedule.periodMonths + monthly.totalCents,
    extensionIds,
  });
  return { retainer_superseded: superseded, retainer_continues: continues };
}

export type PolicyAdjustment = {
  ruleId: string;
  contractDate: string;
  modeledDate: string;
  policy: "weekend_to_next_business_day";
};

// Lists every payment or release whose contractual date lands on a weekend and
// is therefore modeled on the next business day — the runner's policy, not the
// contract's words.
export function policyAdjustments(input: RunInput, scenario: Scenario): PolicyAdjustment[] {
  const adjustments: PolicyAdjustment[] = [];
  for (const candidate of input.candidates) {
    for (const rule of candidate.paymentRules) {
      let contractDay: number | undefined;
      let modeledDay: number | undefined;
      switch (rule.kind) {
        case "on_date":
          contractDay = dayNumber(rule.date);
          modeledDay = rollToBusinessDay(contractDay);
          break;
        case "escrow_release":
          if (
            rule.requiresExtension !== undefined &&
            !scenario.extensionsGranted.includes(rule.requiresExtension)
          ) {
            break;
          }
          contractDay = dayNumber(rule.date);
          modeledDay = rollToBusinessDay(contractDay);
          break;
        case "on_acceptance": {
          const acceptance =
            dayNumber(rule.deliveryDate) +
            rule.acceptanceWindowDays +
            scenario.acceptanceDelayDays;
          contractDay = acceptance + rule.netDays + scenario.paymentLagDays;
          modeledDay = rollToBusinessDay(contractDay);
          break;
        }
        case "escrow_deposit":
          break;
        default: {
          const unexpected: never = rule;
          throw new Error(`unhandled payment rule kind: ${String(unexpected)}`);
        }
      }
      if (contractDay !== undefined && modeledDay !== undefined && modeledDay !== contractDay) {
        adjustments.push({
          ruleId: rule.id,
          contractDate: dateString(contractDay),
          modeledDate: dateString(modeledDay),
          policy: "weekend_to_next_business_day",
        });
      }
    }
  }
  return adjustments;
}
