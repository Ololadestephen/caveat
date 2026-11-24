import { describe, expect, it } from "vitest";
import { normalizeWhitespace, parseMonthDayYear } from "./text.ts";

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normalizeWhitespace("  March 31,\n  2026\t ")).toBe("March 31, 2026");
    expect(normalizeWhitespace("")).toBe("");
  });
});

describe("parseMonthDayYear", () => {
  it("parses Month D, YYYY with and without the comma", () => {
    expect(parseMonthDayYear("January 2, 2027")).toEqual({ iso: "2027-01-02", dayNum: 20820 });
    expect(parseMonthDayYear("March 31 2027")).toEqual({ iso: "2027-03-31", dayNum: 20908 });
  });

  it("is month-name case insensitive", () => {
    expect(parseMonthDayYear("december 31, 2026")?.iso).toBe("2026-12-31");
  });

  it("rejects non-dates and non-months", () => {
    expect(parseMonthDayYear("February 30, 2027")).toBeUndefined();
    expect(parseMonthDayYear("Smarch 1, 2027")).toBeUndefined();
    expect(parseMonthDayYear("2027-01-02")).toBeUndefined();
    expect(parseMonthDayYear("January 2")).toBeUndefined();
  });
});
