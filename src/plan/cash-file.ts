import { isValidDateString, dayNumber } from "../runner/dates.ts";
import type { CostInput } from "../runner/types.ts";
import type { TwinveeAssumptions } from "./twinvee.ts";

export type CashFileCode =
  | "bad_header"
  | "bad_row"
  | "bad_kind"
  | "bad_amount"
  | "bad_date"
  | "duplicate_opening"
  | "missing_opening"
  | "duplicate_floor"
  | "missing_floor"
  | "no_costs"
  | "too_many_costs"
  | "cost_out_of_range"
  | "opening_after_funding"
  | "too_large";

export type CashFileResult =
  | { ok: true; assumptions: TwinveeAssumptions }
  | { ok: false; line: number; code: CashFileCode; detail: string };

const MAX_BYTES = 16 * 1024;
const MAX_COSTS = 60;
const HEADER = "kind,date,amount_usd";
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{2}))?$/;
const NOTE = "Owner cash file my-cash.csv";

function failAt(
  line: number,
  code: CashFileCode,
  detail: string,
): { ok: false; line: number; code: CashFileCode; detail: string } {
  return { ok: false, line, code, detail };
}

// Dollars-and-cents text -> integer cents, string arithmetic only: floats
// could not represent e.g. 0.29 exactly.
function parseAmount(text: string): number | null {
  const m = AMOUNT_RE.exec(text);
  if (m === null) return null;
  const dollars = Number(m[1]);
  const cents = m[2] === undefined ? 0 : Number(m[2]);
  return dollars * 100 + cents;
}

type ParsedRows =
  | {
      ok: true;
      opening: { date: string; cents: number; line: number } | undefined;
      floor: { cents: number } | undefined;
      costs: { date: string; cents: number; line: number }[];
    }
  | { ok: false; line: number; code: CashFileCode; detail: string };

// Each data row: field count, kind, date and amount, sorted into opening /
// floor / costs. First failure wins, in file order.
function parseRows(rows: { raw: string; line: number }[]): ParsedRows {
  let opening: { date: string; cents: number; line: number } | undefined;
  let floor: { cents: number } | undefined;
  const costs: { date: string; cents: number; line: number }[] = [];

  for (const row of rows.slice(1)) {
    const fields = row.raw.split(",");
    if (fields.length !== 3) {
      return failAt(row.line, "bad_row", `expected 3 comma-separated fields, got ${fields.length}`);
    }
    const [kind, date, amount] = fields as [string, string, string];
    if (kind !== "opening" && kind !== "floor" && kind !== "cost") {
      return failAt(row.line, "bad_kind", `kind must be opening, floor or cost, got '${kind}'`);
    }
    if (kind === "floor") {
      if (date !== "") {
        return failAt(row.line, "bad_date", "a floor row must have an empty date");
      }
    } else if (!isValidDateString(date)) {
      return failAt(row.line, "bad_date", `'${date}' is not a real YYYY-MM-DD date`);
    }
    const cents = parseAmount(amount);
    if (cents === null) {
      return failAt(row.line, "bad_amount", `'${amount}' is not an amount like "1234.56"`);
    }
    if (kind === "opening") {
      if (opening !== undefined) {
        return failAt(row.line, "duplicate_opening", "opening may appear exactly once");
      }
      opening = { date, cents, line: row.line };
    } else if (kind === "floor") {
      if (floor !== undefined) {
        return failAt(row.line, "duplicate_floor", "floor may appear exactly once");
      }
      floor = { cents };
    } else {
      costs.push({ date, cents, line: row.line });
    }
  }
  return { ok: true, opening, floor, costs };
}

export type CashAssumptionsBase = {
  note: string;
  startDate: string;
  openingCents: number;
  floorCents: number;
  costs: CostInput[];
};

export type CashRowsFailure = { ok: false; line: number; code: CashFileCode; detail: string };

// Shared row parsing for both cash-file entry points.
function parseCashRows(
  bytes: Uint8Array,
): { ok: true; parsed: Extract<ParsedRows, { ok: true }>; totalLines: number } | CashRowsFailure {
  if (bytes.byteLength > MAX_BYTES) {
    return failAt(0, "too_large", `file is ${bytes.byteLength} bytes; the limit is ${MAX_BYTES}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failAt(1, "bad_header", "file is not valid UTF-8");
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = lines.map((raw, i) => ({
    raw: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    line: i + 1,
  }));
  if (rows.length === 0 || rows[0]!.raw !== HEADER) {
    return failAt(1, "bad_header", `the first line must be exactly '${HEADER}'`);
  }

  const parsed = parseRows(rows);
  if (!parsed.ok) return parsed;
  return { ok: true, parsed, totalLines: rows.length };
}

// Parses the owner's cash file (kind,date,amount_usd rows) into the same
// assumption shape the demo fixture provides. escrowFundingDate and
// escrowFundingNote stay on the fallback: the funding date is a labelled
// contract-timing assumption, not a cash number.
export function parseCashFile(bytes: Uint8Array, fallback: TwinveeAssumptions): CashFileResult {
  const rows = parseCashRows(bytes);
  if (!rows.ok) return rows;
  return buildCashAssumptions(rows.parsed, rows.totalLines, {
    anchorDate: fallback.escrowFundingDate,
    anchorLabel: "the escrow funding date",
    build: (base) => ({
      ...base,
      escrowFundingDate: fallback.escrowFundingDate,
      ...(fallback.escrowFundingNote !== undefined
        ? { escrowFundingNote: fallback.escrowFundingNote }
        : {}),
    }),
  });
}

// The generic path's cash file: the same row grammar, but the opening-date
// anchor is the contract's first payment date rather than an escrow funding
// date, and no escrow fields carry over.
export function parseTermsCashFile(
  bytes: Uint8Array,
  firstPaymentDate: string,
): { ok: true; assumptions: CashAssumptionsBase } | CashRowsFailure {
  const rows = parseCashRows(bytes);
  if (!rows.ok) return rows;
  return buildCashAssumptions(rows.parsed, rows.totalLines, {
    anchorDate: firstPaymentDate,
    anchorLabel: "the first payment date",
    build: (base) => base,
  });
}

type AssumptionSpec<T> = {
  anchorDate: string;
  anchorLabel: string;
  build: (base: CashAssumptionsBase) => T;
};

// Presence, range and ordering checks on the parsed rows, then the
// assumptions record itself.
function buildCashAssumptions<T>(
  parsed: Extract<ParsedRows, { ok: true }>,
  totalLines: number,
  spec: AssumptionSpec<T>,
): { ok: true; assumptions: T } | CashRowsFailure {
  const { opening, floor, costs } = parsed;

  if (opening === undefined) {
    return failAt(totalLines, "missing_opening", "the file has no opening row");
  }
  if (floor === undefined) {
    return failAt(totalLines, "missing_floor", "the file has no floor row");
  }
  if (costs.length === 0) {
    return failAt(totalLines, "no_costs", "the file has no cost rows");
  }
  if (costs.length > MAX_COSTS) {
    return failAt(totalLines, "too_many_costs", `the file has ${costs.length} cost rows; the limit is ${MAX_COSTS}`);
  }
  if (dayNumber(opening.date) > dayNumber(spec.anchorDate)) {
    return failAt(
      opening.line,
      "opening_after_funding",
      `the opening date ${opening.date} is after ${spec.anchorLabel} ${spec.anchorDate}`,
    );
  }
  const [oy, om, od] = opening.date.split("-").map(Number);
  const rangeEnd = `${oy! + 2}-${String(om).padStart(2, "0")}-${String(od).padStart(2, "0")}`;
  for (const cost of costs) {
    if (dayNumber(cost.date) < dayNumber(opening.date) || dayNumber(cost.date) > dayNumber(rangeEnd)) {
      return failAt(
        cost.line,
        "cost_out_of_range",
        `cost on ${cost.date} must fall on or after the opening date ${opening.date} and within 24 months of it`,
      );
    }
  }

  // Ids are assigned in file order (-2, -3 … for repeat months), then costs
  // are sorted by date — Array#sort is stable, so same-month rows keep the
  // file order their ids encode.
  const monthCounts = new Map<string, number>();
  const keyed = costs.map((cost) => {
    const month = cost.date.slice(0, 7);
    const n = (monthCounts.get(month) ?? 0) + 1;
    monthCounts.set(month, n);
    return { ...cost, id: `cost-${month}${n === 1 ? "" : `-${n}`}` };
  });
  keyed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    ok: true,
    assumptions: spec.build({
      note: NOTE,
      startDate: opening.date,
      openingCents: opening.cents,
      floorCents: floor.cents,
      costs: keyed.map((c) => ({ id: c.id, date: c.date, amountCents: c.cents })),
    }),
  };
}
