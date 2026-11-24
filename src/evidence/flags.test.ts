import { describe, expect, it } from "vitest";
import { detectFlags } from "./flags.ts";

const FILE = "03-second-amendment.pdf";

describe("detectFlags", () => {
  it("flags an inverted date range exactly as written", () => {
    const flags = detectFlags([
      {
        fileName: FILE,
        sectionId: "§3(c)",
        text: "During the period from December 31, 2026 until March 31, 2026, releases may occur.",
      },
    ]);
    expect(flags).toEqual([
      {
        kind: "date_range_inverted",
        fileName: FILE,
        sectionId: "§3(c)",
        quote: "from December 31, 2026 until March 31, 2026",
        startDate: "2026-12-31",
        endDate: "2026-03-31",
      },
    ]);
  });

  it("does not flag a normal range", () => {
    const flags = detectFlags([
      {
        fileName: FILE,
        sectionId: "§3(c)",
        text: "The period runs from October 1, 2026 until March 31, 2027.",
      },
    ]);
    expect(flags).toEqual([]);
  });

  it("accepts the 'to' and 'through' connectives and optional commas", () => {
    const flags = detectFlags([
      {
        fileName: FILE,
        sectionId: "§9",
        text: "from January 5 2027 through December 1 2026 inclusive",
      },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.endDate).toBe("2026-12-01");
  });

  it("scans every supplied section and keeps its own attribution", () => {
    const flags = detectFlags([
      { fileName: "a.pdf", sectionId: "§1", text: "from May 1, 2027 to April 1, 2027" },
      { fileName: "b.pdf", sectionId: "§2", text: "clean text" },
      {
        fileName: "b.pdf",
        sectionId: "§3",
        text: "from May 1, 2027 until April 1, 2027 and again from June 1, 2027 until May 1, 2027",
      },
    ]);
    expect(flags).toHaveLength(3);
    expect(flags.map((f) => `${f.fileName}:${f.sectionId}`)).toEqual([
      "a.pdf:§1",
      "b.pdf:§3",
      "b.pdf:§3",
    ]);
  });
});
