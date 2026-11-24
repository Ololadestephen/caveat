const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function isValidDateString(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

// Hinnant's days-from-civil / civil-from-days. Pure integer arithmetic on
// proleptic Gregorian dates; day 0 is 1970-01-01. No Date.now, no local
// timezone, no Intl.
const DAYS_PER_400_YEAR_ERA = 146097;
const DAYS_PER_100_YEARS = 36524;
const DAYS_PER_4_YEARS = 1460;
const DAYS_PER_ERA_MINUS_1 = 146096;
// Day number of 1970-01-01 measured from the algorithm's 0000-03-01 origin.
const UNIX_EPOCH_OFFSET_DAYS = 719468;

export function dayNumber(date: string): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`invalid date string: ${date}`);
  let y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * DAYS_PER_400_YEAR_ERA + doe - UNIX_EPOCH_OFFSET_DAYS;
}

export function dateString(dayNum: number): string {
  const z = dayNum + UNIX_EPOCH_OFFSET_DAYS;
  const era = Math.floor(z / DAYS_PER_400_YEAR_ERA);
  const doe = z - era * DAYS_PER_400_YEAR_ERA;
  const yoe = Math.floor(
    (doe - Math.floor(doe / DAYS_PER_4_YEARS) + Math.floor(doe / DAYS_PER_100_YEARS) - Math.floor(doe / DAYS_PER_ERA_MINUS_1)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export function weekday(dayNum: number): number {
  // 1970-01-01 was a Thursday; 0 = Sunday … 6 = Saturday.
  return (((dayNum + 4) % 7) + 7) % 7;
}

// Saturday/Sunday roll to the next Monday; business days (weekends only — there
// is deliberately no holiday calendar) are unchanged.
export function rollToBusinessDay(dayNum: number): number {
  const dow = weekday(dayNum);
  if (dow === 6) return dayNum + 2;
  if (dow === 0) return dayNum + 1;
  return dayNum;
}
