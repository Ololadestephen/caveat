import { normalizeWhitespace, parseMonthDayYear } from "../text.ts";

export type EvidenceFlag = {
  kind: "date_range_inverted";
  fileName: string;
  sectionId: string;
  quote: string;
  startDate: string;
  endDate: string;
};

const DATE_RANGE_RE =
  /from\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s+(?:until|to|through)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi;

// Generic detector: any "from <date> until|to|through <date>" range where the
// end precedes the start is flagged exactly as written — never corrected.
export function detectFlags(
  sections: readonly { fileName: string; sectionId: string; text: string }[],
): EvidenceFlag[] {
  const flags: EvidenceFlag[] = [];
  for (const section of sections) {
    const text = normalizeWhitespace(section.text);
    DATE_RANGE_RE.lastIndex = 0;
    for (;;) {
      const match = DATE_RANGE_RE.exec(text);
      if (match === null) break;
      const start = parseMonthDayYear(match[1] ?? "");
      const end = parseMonthDayYear(match[2] ?? "");
      if (start !== undefined && end !== undefined && end.dayNum < start.dayNum) {
        flags.push({
          kind: "date_range_inverted",
          fileName: section.fileName,
          sectionId: section.sectionId,
          quote: normalizeWhitespace(match[0]),
          startDate: start.iso,
          endDate: end.iso,
        });
      }
    }
  }
  return flags;
}
