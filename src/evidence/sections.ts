import { normalizeWhitespace } from "../text.ts";
import type { PdfPageLines } from "./pdf-text.ts";

export type ContractSection = {
  fileName: string;
  sectionId: string;
  text: string;
  pages: [number, number];
};

// Top-level headings "3. Transaction Compensation": a number up to 20 followed
// by a capitalised word, and it must continue the sequence (previous top-level
// number + 1). This rejects wrapped lines that happen to start with a year or
// an amount ("2026. All cash payments…" never becomes a heading).
const TOP_HEADING_RE = /^(\d{1,2})\.\s+([A-Z])/;
// Decimal clause numbers at line start, e.g. "1.3 Company shall…" -> §1.3.
const DECIMAL_CLAUSE_RE = /^(\d{1,2})\.(\d{1,2})\s/;
// Letter markers alone on a line ("a)", "b)") or inline "(a)"/"(b)". Inline
// markers are limited to a–h so in-text enumerations like "(i)"/"(ii)" are
// never mistaken for clause letters.
const STANDALONE_LETTER_RE = /^([a-z])\)\s*$/;
const INLINE_LETTER_RE = /\(([a-h])\)/g;
// Nested roman markers alone on a line ("i)", "ii)", "iii)", "iv)" …).
const STANDALONE_ROMAN_RE = /^((?:i{1,3}|iv|v|vi{0,3}|ix|x))\)\s*$/;
const LONE_NUMBER_RE = /^\d+$/;
const WITNESS_RE = /IN WITNESS WHEREOF/i;

const ROMAN_VALUES: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

type OpenSection = { id: string; lines: string[]; startPage: number; lastPage: number };

// Turn extracted page lines into labelled contract sections. Sections end at
// "IN WITNESS WHEREOF" so signature blocks never become sections, and lone
// page-number lines are dropped. Letter and roman markers are only accepted in
// sequence under the current top-level section.
export function extractSections(fileName: string, pages: PdfPageLines[]): ContractSection[] {
  const sections: ContractSection[] = [];
  let current: OpenSection | undefined;
  let expectedTop = 0;
  let expectedLetterCode = "a".charCodeAt(0);
  let expectedRoman = 1;
  let currentTop = 0;
  let currentLetter = "";
  let done = false;

  const close = (): void => {
    if (current === undefined) return;
    const text = normalizeWhitespace(current.lines.join(" "));
    if (text.length > 0) {
      sections.push({
        fileName,
        sectionId: current.id,
        text,
        pages: [current.startPage, current.lastPage],
      });
    }
    current = undefined;
  };

  const open = (id: string, page: number): OpenSection => {
    close();
    const next: OpenSection = { id, lines: [], startPage: page, lastPage: page };
    current = next;
    return next;
  };

  const append = (line: string, page: number): void => {
    if (current === undefined) return;
    current.lines.push(line);
    current.lastPage = page;
  };

  for (const { page, lines } of pages) {
    if (done) break;
    for (const line of lines) {
      const trimmed = line.trim();
      if (WITNESS_RE.test(trimmed)) {
        done = true;
        break;
      }
      if (trimmed.length === 0 || LONE_NUMBER_RE.test(trimmed)) continue;

      const decimal = DECIMAL_CLAUSE_RE.exec(trimmed);
      if (decimal !== null) {
        open(`§${decimal[1]}.${decimal[2]}`, page);
        append(trimmed, page);
        continue;
      }

      const top = TOP_HEADING_RE.exec(trimmed);
      if (top !== null) {
        const number = Number(top[1]);
        // The first heading anchors the sequence at whatever number the
        // document starts with; later headings must continue it (+1).
        if (number <= 20 && (expectedTop === 0 || number === expectedTop)) {
          open(`§${number}`, page);
          expectedTop = number + 1;
          currentTop = number;
          currentLetter = "";
          expectedLetterCode = "a".charCodeAt(0);
          expectedRoman = 1;
          append(trimmed, page);
          continue;
        }
      }

      const standalone = STANDALONE_LETTER_RE.exec(trimmed);
      if (
        standalone !== null &&
        currentTop > 0 &&
        standalone[1] === String.fromCharCode(expectedLetterCode)
      ) {
        open(`§${currentTop}(${standalone[1]})`, page);
        currentLetter = standalone[1] ?? "";
        expectedLetterCode += 1;
        expectedRoman = 1;
        continue;
      }

      const roman = STANDALONE_ROMAN_RE.exec(trimmed);
      if (
        roman !== null &&
        currentLetter.length > 0 &&
        ROMAN_VALUES[roman[1] ?? ""] === expectedRoman
      ) {
        open(`§${currentTop}(${currentLetter})(${roman[1]})`, page);
        expectedRoman += 1;
        continue;
      }

      // Inline letter markers "(a)" split the line: text before the marker
      // stays in the current section, the marker opens the next letter section.
      if (currentTop > 0) {
        let remainder = trimmed;
        let handled = false;
        for (;;) {
          INLINE_LETTER_RE.lastIndex = 0;
          const match = INLINE_LETTER_RE.exec(remainder);
          if (
            match === null ||
            match[1] !== String.fromCharCode(expectedLetterCode)
          ) {
            break;
          }
          const before = remainder.slice(0, match.index).trim();
          if (before.length > 0) append(before, page);
          const letter = match[1] ?? "";
          open(`§${currentTop}(${letter})`, page);
          currentLetter = letter;
          expectedLetterCode += 1;
          expectedRoman = 1;
          remainder = remainder.slice(match.index + match[0].length).trim();
          handled = true;
        }
        if (handled) {
          if (remainder.length > 0) append(remainder, page);
          continue;
        }
      }

      append(trimmed, page);
    }
  }
  close();
  return sections;
}
