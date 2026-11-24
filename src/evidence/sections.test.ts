import { describe, expect, it } from "vitest";
import { groupItemsIntoLines } from "./pdf-text.ts";
import { extractSections } from "./sections.ts";
import type { PdfPageLines } from "./pdf-text.ts";

describe("groupItemsIntoLines", () => {
  it("groups items by y position and hasEOL", () => {
    const items = [
      { str: "Hello ", y: 100 },
      { str: "world", y: 100, hasEOL: true },
      { str: "next", y: 90 },
      { str: " line", y: 90, hasEOL: true },
      { str: "tail", y: 70 },
    ];
    expect(groupItemsIntoLines(items)).toEqual(["Hello world", "next line", "tail"]);
  });

  it("drops empty lines", () => {
    const items = [
      { str: "   ", y: 100, hasEOL: true },
      { str: "text", y: 90, hasEOL: true },
    ];
    expect(groupItemsIntoLines(items)).toEqual(["text"]);
  });
});

describe("extractSections — decimal-clause format (01 style)", () => {
  const pages: PdfPageLines[] = [
    {
      page: 1,
      lines: [
        "CONSULTING AGREEMENT",
        "This agreement is made as of April 1, 2026.",
        "1.3 Company shall compensate Consultant at a rate of $6,000 per month for work related to the Services.",
        "1.4 The fees above shall be paid via his limited liability company on the 1st of each month.",
      ],
    },
    {
      page: 2,
      lines: [
        "1", // page-number artifact: lone number line, dropped
        "1.5 The term of this Agreement shall commence as of April 1, 2026 and expire on December 31, 2026.",
      ],
    },
  ];

  it("extracts decimal sections and drops lone-number lines", () => {
    const sections = extractSections("01-consulting-agreement.pdf", pages);
    expect(sections.map((s) => s.sectionId)).toEqual(["Recitals", "§1.3", "§1.4", "§1.5"]);
    expect(sections[0]?.title).toBe("Recitals");
    expect(sections[0]?.text).toBe("CONSULTING AGREEMENT This agreement is made as of April 1, 2026.");
    expect(sections[1]?.text).toBe(
      "1.3 Company shall compensate Consultant at a rate of $6,000 per month for work related to the Services.",
    );
    expect(sections[3]?.pages).toEqual([2, 2]);
  });
});

describe("extractSections — inline-letter format (02 style)", () => {
  const pages: PdfPageLines[] = [
    {
      page: 1,
      lines: [
        "FIRST AMENDMENT TO CONSULTING AGREEMENT",
        "1. Amendment",
        "(a) The Agreement is amended as set out below.",
        "2. Defined Terms",
        "(a) Capitalised terms have the meanings given in the Agreement.",
        "3. Transaction Compensation",
        "(a) The Company shall pay Consultant $25,000 upon execution of the Agreement and Plan of Merger.",
        "(b) The Company shall pay Consultant $25,000 upon the earlier of (i) the closing of the proposed merger transaction or (ii) September 30,",
        "2026. All cash payments under this section shall be made promptly.",
      ],
    },
    { page: 2, lines: ["IN WITNESS WHEREOF, the parties have executed this amendment.", "/s/ Signatory"] },
  ];

  it("extracts top-level and letter sections without swallowing enumerations", () => {
    const sections = extractSections("02-first-amendment.pdf", pages);
    expect(sections.map((s) => s.sectionId)).toEqual([
      "Recitals",
      "§1",
      "§1(a)",
      "§2",
      "§2(a)",
      "§3",
      "§3(a)",
      "§3(b)",
    ]);
  });

  it("keeps the wrapped '2026. All cash payments' line inside §3(b)", () => {
    const b = extractSections("02-first-amendment.pdf", pages).find((s) => s.sectionId === "§3(b)");
    expect(b?.text).toBe(
      "The Company shall pay Consultant $25,000 upon the earlier of (i) the closing of the proposed merger transaction or (ii) September 30, 2026. All cash payments under this section shall be made promptly.",
    );
    expect(b?.text).not.toContain("(b)");
  });

  it("stops at IN WITNESS WHEREOF", () => {
    const sections = extractSections("02-first-amendment.pdf", pages);
    expect(sections.every((s) => !s.text.includes("Signatory"))).toBe(true);
    expect(sections.every((s) => !s.text.includes("IN WITNESS"))).toBe(true);
  });
});

describe("extractSections — standalone-letter format (03 style)", () => {
  const pages: PdfPageLines[] = [
    {
      page: 1,
      lines: [
        "SECOND AMENDMENT TO CONSULTING AGREEMENT",
        "1. Recitals",
        "The recitals are incorporated.",
        "2. Effective Date",
        "This amendment is effective October 1, 2026.",
        "3. Transaction Compensation",
      ],
    },
    {
      page: 2,
      lines: [
        "a)",
        "The Company shall pay Consultant $25,000 per month.",
        "b)",
        "The Company shall fund an escrow of $150,000. Scheduled payments:",
        "i)",
        "$75,000 shall be paid to Consultant on January 2,",
        "2027.",
        "ii)",
        "$25,000 shall be paid to Consultant on January 2, 2027 if extended.",
        "iii)",
        "$25,000 shall be paid to Consultant on February 2, 2027 if extended.",
        "iv)",
        "$25,000 shall be paid to Consultant on March 2, 2027 if extended.",
        "c)",
      ],
    },
    {
      page: 3,
      lines: [
        "During the period from December 31, 2026 until March 31,",
        "2026, the Consultant may receive the foregoing releases.",
        "d)",
        "No other terms change.",
        "4. Miscellaneous",
        "Except as expressly amended, all terms of the Consulting Agreement remain unchanged and in full force and effect.",
      ],
    },
    { page: 4, lines: ["IN WITNESS WHEREOF the parties have executed this Amendment.", "/s/ Signatory"] },
  ];

  it("extracts nested section ids in document order", () => {
    const sections = extractSections("03-second-amendment.pdf", pages);
    expect(sections.map((s) => s.sectionId)).toEqual([
      "Recitals",
      "§1",
      "§2",
      "§3",
      "§3(a)",
      "§3(b)",
      "§3(b)(i)",
      "§3(b)(ii)",
      "§3(b)(iii)",
      "§3(b)(iv)",
      "§3(c)",
      "§3(d)",
      "§4",
    ]);
  });

  it("carries a page range for a section spanning pages", () => {
    const c = extractSections("03-second-amendment.pdf", pages).find((s) => s.sectionId === "§3(c)");
    expect(c?.pages).toEqual([2, 3]);
    expect(c?.text).toBe(
      "During the period from December 31, 2026 until March 31, 2026, the Consultant may receive the foregoing releases.",
    );
  });

  it("normalises wrapped text to single spaces", () => {
    const i = extractSections("03-second-amendment.pdf", pages).find((s) => s.sectionId === "§3(b)(i)");
    expect(i?.text).toBe("$75,000 shall be paid to Consultant on January 2, 2027.");
  });
});

describe("extractSections — sequence enforcement", () => {
  it("anchors on the first heading's number, then enforces sequence", () => {
    const pages: PdfPageLines[] = [
      {
        page: 1,
        lines: [
          "3. Compensation", // documents may start at a number other than 1
          "First section text.",
          "7. Not a heading", // jumps from 3 to 7: not sequential, stays in §3
          "Still first section text.",
          "4. Next",
          "Next section text.",
        ],
      },
    ];
    const sections = extractSections("doc.pdf", pages);
    expect(sections.map((s) => s.sectionId)).toEqual(["§3", "§4"]);
    expect(sections[0]?.text).toContain("7. Not a heading");
  });

  it("ignores out-of-sequence letter markers", () => {
    const pages: PdfPageLines[] = [
      {
        page: 1,
        lines: [
          "3. Compensation",
          "(a) First letter section.",
          "(c) Out of sequence stays inside (a).",
        ],
      },
    ];
    const sections = extractSections("doc.pdf", pages);
    expect(sections.map((s) => s.sectionId)).toEqual(["§3", "§3(a)"]);
    expect(sections[1]?.text).toContain("(c) Out of sequence");
  });
});
