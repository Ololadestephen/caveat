import { dateString, dayNumber, isValidDateString } from "../runner/dates.ts";
import type { PaymentRule } from "../runner/types.ts";
import type { ValidatedSchedule } from "../interpret/schedule.ts";

export type Lever =
  | "upfront_deposit"
  | "earlier_release"
  | "milestone_split"
  | "shorter_payment_terms";

export type ProposedCandidate = {
  lever: Lever;
  amount_cents: number | null;
  date: string | null;
  split_count: number | null;
  net_days: number | null;
  rationale: string;
};

// Everything a lever compile needs from the validated schedule + assumptions.
export type SearchBase = {
  fundingDate: string;
  fundingAmountCents: number;
  r1Id: string;
  r1AmountCents: number;
  r1Date: string;
  monthlyCents: number;
  monthsCovered: number | null;
  coveredMonths: string[];
  rules: PaymentRule[];
};

export type CompileOk = {
  ok: true;
  escrowRules: PaymentRule[];
  rankCents: number;
  centDays: number;
  summary: string;
};

type CompileFail = { ok: false; code: string; field: string; detail: string };

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "2026-11-13" -> "Nov 13, 2026"
function fmtDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${MONTH_ABBR[Number(month) - 1]} ${Number(day)}, ${year}`;
}

// $8,000 whole dollars, else $8,000.50.
function money(cents: number): string {
  const grouped = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = cents % 100;
  return rest === 0 ? `$${grouped}` : `$${grouped}.${String(rest).padStart(2, "0")}`;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

// Same day-of-month n months later (callers keep day-of-month <= 28).
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = (y ?? 0) * 12 + (m ?? 1) - 1 + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDayOfMonth(month: string): string {
  return dateString(dayNumber(addMonths(`${month}-01`, 1)) - 1);
}

function daysEarlier(later: string, earlier: string): number {
  return dayNumber(later) - dayNumber(earlier);
}

function fail(code: string, field: string, detail: string): CompileFail {
  return { ok: false, code, field, detail };
}

type FieldSpec = { required: (keyof ProposedCandidate)[]; allowed: (keyof ProposedCandidate)[] };

const FIELD_SPECS: Record<Lever, FieldSpec> = {
  upfront_deposit: { required: ["amount_cents", "date"], allowed: ["amount_cents", "date"] },
  earlier_release: { required: ["amount_cents", "date"], allowed: ["amount_cents", "date"] },
  milestone_split: {
    required: ["amount_cents", "date", "split_count"],
    allowed: ["amount_cents", "date", "split_count"],
  },
  shorter_payment_terms: { required: ["net_days"], allowed: ["net_days"] },
};

function checkFields(
  proposal: ProposedCandidate,
  spec: FieldSpec,
): CompileFail | undefined {
  for (const field of spec.required) {
    if (proposal[field] === null) {
      return fail("missing_field", field, `${proposal.lever} requires ${field}`);
    }
  }
  for (const field of [
    "amount_cents",
    "date",
    "split_count",
    "net_days",
  ] as const) {
    if (!spec.allowed.includes(field) && proposal[field] !== null) {
      return fail(
        "unexpected_field",
        field,
        `${proposal.lever} does not take ${field}`,
      );
    }
  }
  return undefined;
}

function checkAmount(
  value: number | null,
  max: number,
): { amount: number } | { failure: CompileFail } {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value % 100 !== 0 ||
    value <= 0 ||
    value > max
  ) {
    return {
      failure: fail(
        "invalid_amount",
        "amount_cents",
        "amount_cents must be an integer multiple of 100 cents within the first release",
      ),
    };
  }
  return { amount: value };
}

function checkDate(value: string | null): { date: string } | { failure: CompileFail } {
  if (typeof value !== "string" || !isValidDateString(value)) {
    return {
      failure: fail("invalid_date", "date", "date must be a valid YYYY-MM-DD civil date"),
    };
  }
  return { date: value };
}

type BaseParts = {
  funding: PaymentRule;
  release1: PaymentRule;
  unchanged: PaymentRule[];
};

type EmitArgs = {
  paymentRules: PaymentRule[];
  newReleases: PaymentRule[];
  r1RemainderCents: number;
  rankCents: number;
  centDays: number;
  summary: string;
};

// Assembles the final rule list: the new releases, the first release's
// remainder and the untouched releases in date order, then everything else.
function emitCompiled(parts: BaseParts, args: EmitArgs): CompileOk {
  const releases = [...args.newReleases];
  if (args.r1RemainderCents > 0) {
    releases.push({ ...parts.release1, amountCents: args.r1RemainderCents });
  }
  releases.push(...parts.unchanged.filter((r) => r.kind === "escrow_release"));
  releases.sort((a, b) => {
    const ad = a.kind === "escrow_release" ? dayNumber(a.date) : 0;
    const bd = b.kind === "escrow_release" ? dayNumber(b.date) : 0;
    if (ad !== bd) return ad - bd;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const others = parts.unchanged.filter((r) => r.kind !== "escrow_release");
  return {
    ok: true,
    escrowRules: [...args.paymentRules, ...releases, ...others],
    rankCents: args.rankCents,
    centDays: args.centDays,
    summary: args.summary,
  };
}

function compileUpfrontDeposit(
  base: SearchBase,
  proposal: ProposedCandidate,
  parts: BaseParts,
): CompileOk | CompileFail {
  const amount = checkAmount(proposal.amount_cents, base.r1AmountCents);
  if ("failure" in amount) return amount.failure;
  const date = checkDate(proposal.date);
  if ("failure" in date) return date.failure;
  if (date.date !== base.fundingDate) {
    return fail(
      "deposit_date",
      "date",
      `a deposit lands on the escrow funding date ${base.fundingDate}`,
    );
  }
  const A = amount.amount;
  return emitCompiled(parts, {
    paymentRules: [
      { ...parts.funding, amountCents: (parts.funding.amountCents ?? 0) - A },
      { id: "deposit", kind: "on_date", amountCents: A, date: base.fundingDate },
    ],
    newReleases: [],
    r1RemainderCents: base.r1AmountCents - A,
    rankCents: A,
    centDays: A * daysEarlier(base.r1Date, base.fundingDate),
    summary: `pay ${money(A)} of the escrow funding to the consultant as cash at signing (modeled as ${fmtDate(base.fundingDate)}), reducing the ${fmtDate(base.r1Date)} release to ${money(base.r1AmountCents - A)}`,
  });
}

function compileEarlierRelease(
  base: SearchBase,
  proposal: ProposedCandidate,
  parts: BaseParts,
): CompileOk | CompileFail {
  const amount = checkAmount(proposal.amount_cents, base.r1AmountCents);
  if ("failure" in amount) return amount.failure;
  const date = checkDate(proposal.date);
  if ("failure" in date) return date.failure;
  if (
    dayNumber(date.date) < dayNumber(base.fundingDate) ||
    dayNumber(date.date) >= dayNumber(base.r1Date)
  ) {
    return fail(
      "release_window",
      "date",
      `an early release must fall on or after ${base.fundingDate} and before ${base.r1Date}`,
    );
  }
  const A = amount.amount;
  return emitCompiled(parts, {
    paymentRules: [parts.funding],
    newReleases: [
      { id: "early-release", kind: "escrow_release", amountCents: A, date: date.date },
    ],
    r1RemainderCents: base.r1AmountCents - A,
    rankCents: A,
    centDays: A * daysEarlier(base.r1Date, date.date),
    summary: `release ${money(A)} of the ${fmtDate(base.r1Date)} escrow payment on ${fmtDate(date.date)}, reducing that release to ${money(base.r1AmountCents - A)}`,
  });
}

// split_count, the whole-dollar requirement and the first date's day-of-month.
function checkSplitShape(
  proposal: ProposedCandidate,
  amountCents: number,
  date: { date: string },
): { failure: CompileFail } | { N: number } {
  const N = proposal.split_count;
  if (typeof N !== "number" || !Number.isInteger(N) || (N !== 2 && N !== 3)) {
    return { failure: fail("invalid_split_count", "split_count", "split_count must be 2 or 3") };
  }
  if (amountCents % 100 !== 0) {
    return {
      failure: fail(
        "split_not_whole_dollars",
        "amount_cents",
        "amount_cents must be a whole number of dollars",
      ),
    };
  }
  if (Number(date.date.slice(8)) > 28) {
    return {
      failure: fail(
        "split_day_of_month",
        "date",
        "the first split date must be on or before the 28th so every part repeats on the same day-of-month",
      ),
    };
  }
  return { N };
}

// The N monthly parts: each repeats the first date's day-of-month and must
// land between the funding date and the first release. Whole dollars split
// evenly, remainder dollars go to the earliest parts.
function buildSplitParts(
  base: SearchBase,
  amountCents: number,
  N: number,
  firstDate: string,
): { failure: CompileFail } | { parts: PaymentRule[]; centDays: number } {
  const dollars = Math.floor(amountCents / 100);
  const baseDollars = Math.floor(dollars / N);
  const extraDollars = dollars % N;
  const parts: PaymentRule[] = [];
  for (let i = 0; i < N; i += 1) {
    const partDate = addMonths(firstDate, i);
    if (
      dayNumber(partDate) < dayNumber(base.fundingDate) ||
      dayNumber(partDate) >= dayNumber(base.r1Date)
    ) {
      return {
        failure: fail(
          "split_out_of_range",
          "date",
          `split part ${i + 1} on ${partDate} must fall on or after ${base.fundingDate} and before ${base.r1Date}`,
        ),
      };
    }
    parts.push({
      id: `split-${i + 1}`,
      kind: "escrow_release",
      amountCents: (baseDollars + (i < extraDollars ? 1 : 0)) * 100,
      date: partDate,
    });
  }
  const centDays = parts.reduce(
    (sum, p, i) =>
      sum + (p.amountCents ?? 0) * daysEarlier(base.r1Date, addMonths(firstDate, i)),
    0,
  );
  return { parts, centDays };
}

function compileMilestoneSplit(
  base: SearchBase,
  proposal: ProposedCandidate,
  baseParts: BaseParts,
): CompileOk | CompileFail {
  const A = proposal.amount_cents;
  if (
    typeof A !== "number" ||
    !Number.isInteger(A) ||
    A <= 0 ||
    A > base.r1AmountCents
  ) {
    return fail(
      "invalid_amount",
      "amount_cents",
      "amount_cents must be a positive integer within the first release",
    );
  }
  const date = checkDate(proposal.date);
  if ("failure" in date) return date.failure;
  const shape = checkSplitShape(proposal, A, date);
  if ("failure" in shape) return shape.failure;
  const N = shape.N;
  const built = buildSplitParts(base, A, N, date.date);
  if ("failure" in built) return built.failure;
  const { parts, centDays } = built;
  const extraDollars = Math.floor(A / 100) % N;
  return emitCompiled(baseParts, {
    paymentRules: [baseParts.funding],
    newReleases: parts,
    r1RemainderCents: base.r1AmountCents - A,
    rankCents: A,
    centDays,
    summary: `release ${money(A)} of the ${fmtDate(base.r1Date)} escrow payment in ${N} monthly parts ${
      extraDollars === 0
        ? `of ${money(A / N)}`
        : `(${parts.map((p) => money(p.amountCents ?? 0)).join(", ")})`
    } from ${fmtDate(date.date)}, reducing that release to ${money(base.r1AmountCents - A)}`,
  });
}

function compileShorterPaymentTerms(
  base: SearchBase,
  proposal: ProposedCandidate,
  baseParts: BaseParts,
): CompileOk | CompileFail {
  const K = proposal.net_days;
  if (typeof K !== "number" || !Number.isInteger(K) || K < 0 || K > 60) {
    return fail(
      "invalid_net_days",
      "net_days",
      "net_days must be an integer between 0 and 60",
    );
  }
  if (base.monthsCovered === null) {
    return fail(
      "lever_not_applicable",
      "net_days",
      "the first release does not divide into whole months",
    );
  }
  const moved: { month: string; date: string }[] = [];
  for (const month of base.coveredMonths) {
    const due = dateString(dayNumber(lastDayOfMonth(month)) + K);
    if (dayNumber(due) < dayNumber(base.r1Date)) moved.push({ month, date: due });
  }
  if (moved.length === 0) {
    return fail(
      "no_change",
      "net_days",
      "no covered month's payment moves earlier than the first release date",
    );
  }
  const parts: PaymentRule[] = moved.map((m) => ({
    id: `terms-${m.month}`,
    kind: "escrow_release",
    amountCents: base.monthlyCents,
    date: m.date,
  }));
  const movedCents = base.monthlyCents * moved.length;
  const centDays = moved.reduce(
    (sum, m) => sum + base.monthlyCents * daysEarlier(base.r1Date, m.date),
    0,
  );
  const movedDates = moved.map((m) => fmtDate(m.date)).join("; ");
  return emitCompiled(baseParts, {
    paymentRules: [baseParts.funding],
    newReleases: parts,
    r1RemainderCents: base.r1AmountCents - movedCents,
    rankCents: movedCents,
    centDays,
    summary: `release each month's ${money(base.monthlyCents)} of the ${fmtDate(base.r1Date)} escrow payment ${K} days after the month ends (${movedDates}), reducing that release to ${money(base.r1AmountCents - movedCents)}`,
  });
}

// The deterministic rule rewrite for one lever. Money only moves earlier;
// nothing is added to the deal.
function compile(base: SearchBase, proposal: ProposedCandidate): CompileOk | CompileFail {
  const spec = FIELD_SPECS[proposal.lever];
  if (spec === undefined) {
    return fail("unknown_lever", "lever", `unknown lever ${String(proposal.lever)}`);
  }
  const fieldFailure = checkFields(proposal, spec);
  if (fieldFailure !== undefined) return fieldFailure;

  const funding = base.rules.find((r) => r.id === "escrow-funding");
  const release1 = base.rules.find((r) => r.id === base.r1Id);
  if (funding === undefined || release1 === undefined || release1.kind !== "escrow_release") {
    return fail(
      "missing_base_rule",
      "escrowRules",
      "search base lacks the escrow funding or first release rule",
    );
  }
  const parts: BaseParts = {
    funding,
    release1,
    unchanged: base.rules.filter((r) => r !== funding && r !== release1),
  };

  switch (proposal.lever) {
    case "upfront_deposit":
      return compileUpfrontDeposit(base, proposal, parts);
    case "earlier_release":
      return compileEarlierRelease(base, proposal, parts);
    case "milestone_split":
      return compileMilestoneSplit(base, proposal, parts);
    case "shorter_payment_terms":
      return compileShorterPaymentTerms(base, proposal, parts);
    default: {
      const unexpected: never = proposal.lever;
      return fail("unknown_lever", "lever", `unknown lever ${String(unexpected)}`);
    }
  }
}

export function compileCandidate(
  base: SearchBase,
  proposal: ProposedCandidate,
): CompileOk | CompileFail {
  if (
    typeof proposal.rationale !== "string" ||
    proposal.rationale.length === 0 ||
    proposal.rationale.length > 300
  ) {
    return fail(
      "bad_rationale",
      "rationale",
      "rationale must be a non-empty string of at most 300 characters",
    );
  }
  return compile(base, proposal);
}

// Derives the compile base: funding rule + first unconditional release + the
// months that release covers, from the validated schedule and assumptions.
export function buildSearchBase(
  schedule: ValidatedSchedule,
  escrowRules: PaymentRule[],
  fundingDate: string,
): SearchBase {
  const r1 = schedule.releases.find((r) => r.extensionId === undefined);
  if (r1 === undefined) {
    throw new Error("schedule has no unconditional release");
  }
  const monthly = schedule.monthlyAmountCents;
  const divisible = monthly > 0 && r1.amountCents % monthly === 0;
  const monthsCovered = divisible ? r1.amountCents / monthly : null;
  const coveredMonths: string[] = [];
  if (monthsCovered !== null) {
    let month = monthKey(fundingDate);
    for (let i = 0; i < monthsCovered; i += 1) {
      coveredMonths.push(month);
      month = addMonths(`${month}-01`, 1).slice(0, 7);
    }
  }
  return {
    fundingDate,
    fundingAmountCents: schedule.monthlyAmountCents * schedule.periodMonths,
    r1Id: r1.id,
    r1AmountCents: r1.amountCents,
    r1Date: r1.date,
    monthlyCents: monthly,
    monthsCovered,
    coveredMonths,
    rules: escrowRules,
  };
}
