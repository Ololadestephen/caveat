import { describe, expect, it } from "vitest";
import { dateString, dayNumber, isValidDateString, rollToBusinessDay, weekday } from "./dates.ts";

describe("isValidDateString", () => {
  it("accepts real calendar dates", () => {
    expect(isValidDateString("2027-01-04")).toBe(true);
    expect(isValidDateString("2024-02-29")).toBe(true);
    expect(isValidDateString("2000-02-29")).toBe(true);
    expect(isValidDateString("2027-12-31")).toBe(true);
  });

  it("rejects impossible dates", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2023-02-29")).toBe(false);
    expect(isValidDateString("1900-02-29")).toBe(false);
    expect(isValidDateString("2027-13-01")).toBe(false);
    expect(isValidDateString("2027-00-10")).toBe(false);
    expect(isValidDateString("2027-01-32")).toBe(false);
    expect(isValidDateString("2027-04-31")).toBe(false);
  });

  it("rejects non-YYYY-MM-DD shapes", () => {
    expect(isValidDateString("2027-1-4")).toBe(false);
    expect(isValidDateString("01/04/2027")).toBe(false);
    expect(isValidDateString("2027-01-04T00:00:00Z")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });
});

describe("dayNumber/dateString", () => {
  it("uses 1970-01-01 as day zero", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
  });

  it("round-trips dates including leap days", () => {
    for (const date of ["1970-01-01", "2000-02-29", "2024-02-29", "2027-01-04", "1999-12-31"]) {
      expect(dateString(dayNumber(date))).toBe(date);
    }
  });

  it("counts days linearly across month and year boundaries", () => {
    expect(dayNumber("2027-01-05") - dayNumber("2026-12-29")).toBe(7);
    expect(dayNumber("2024-03-01") - dayNumber("2024-02-28")).toBe(2);
  });
});

describe("weekday", () => {
  it("returns 4 (Thursday) for the epoch", () => {
    expect(weekday(0)).toBe(4);
  });

  it("identifies known weekdays", () => {
    expect(weekday(dayNumber("2027-01-04"))).toBe(1); // Monday
    expect(weekday(dayNumber("2027-01-02"))).toBe(6); // Saturday
    expect(weekday(dayNumber("2027-01-03"))).toBe(0); // Sunday
    expect(weekday(dayNumber("2026-10-01"))).toBe(4); // Thursday
  });
});

describe("rollToBusinessDay", () => {
  it("rolls Saturday and Sunday to Monday, leaves weekdays alone", () => {
    expect(dateString(rollToBusinessDay(dayNumber("2027-01-02")))).toBe("2027-01-04");
    expect(dateString(rollToBusinessDay(dayNumber("2027-01-03")))).toBe("2027-01-04");
    expect(dateString(rollToBusinessDay(dayNumber("2027-01-01")))).toBe("2027-01-01");
    expect(dateString(rollToBusinessDay(dayNumber("2027-01-04")))).toBe("2027-01-04");
    expect(dateString(rollToBusinessDay(dayNumber("2027-01-08")))).toBe("2027-01-08");
  });
});
