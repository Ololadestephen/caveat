import { dayNumber, isValidDateString } from "./runner/dates.ts";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const MONTH_DAY_YEAR_RE = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/;

// Parses "Month D, YYYY" with the comma optional (e.g. both "January 2, 2027"
// and "March 31 2027"). Returns the ISO date plus its UTC day number, or
// undefined for anything that is not a real calendar date.
export function parseMonthDayYear(
  value: string,
): { iso: string; dayNum: number } | undefined {
  const match = MONTH_DAY_YEAR_RE.exec(value.trim());
  if (!match) return undefined;
  const month = MONTHS[match[1]?.toLowerCase() ?? ""];
  if (month === undefined) return undefined;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  if (!isValidDateString(iso)) return undefined;
  return { iso, dayNum: dayNumber(iso) };
}
