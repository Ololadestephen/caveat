import { normalizeWhitespace } from "../text.ts";
import type { PdfPageLines } from "./pdf-text.ts";

export type ContractSection = {
  fileName: string;
  sectionId: string;
  // The heading's title text for top-level "N. Title" sections (e.g.
  // "Recitals", "Transaction Compensation"); also "Recitals" for the emitted
  // preamble. Undefined for decimal-clause and letter/roman subsections.
  title?: string;
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

type OpenSection = {
  id: string;
  title: string | undefined;
  lines: string[];
  startPage: number;
  lastPage: number;
};

// Per-file parser state: the current open section plus the marker sequences
// expected under it. Letter and roman markers are only accepted in sequence
// under the current top-level section.
class Sectionizer {
  readonly sections: ContractSection[] = [];
  done = false;
  private current: OpenSection | undefined;
  private expectedTop = 0;
  private expectedLetterCode = "a".charCodeAt(0);
  private expectedRoman = 1;
  private currentTop = 0;
  private currentLetter = "";
  private readonly fileName: string;

  constructor(fileName: string) {
    this.fileName = fileName;
  }

  feed(line: string, page: number): void {
    const trimmed = line.trim();
    if (WITNESS_RE.test(trimmed)) {
      this.done = true;
      return;
    }
    if (trimmed.length === 0 || LONE_NUMBER_RE.test(trimmed)) return;
    if (this.decimalClause(trimmed, page)) return;
    if (this.topHeading(trimmed, page)) return;
    if (this.standaloneLetter(trimmed, page)) return;
    if (this.standaloneRoman(trimmed, page)) return;
    if (this.inlineLetters(trimmed, page)) return;
    // Leading text before the first numbered section is the preamble
    // (recitals, title lines); it becomes a "Recitals" section so citations
    // can point at it.
    if (this.current === undefined) {
      this.open("Recitals", page, "Recitals");
    }
    this.append(trimmed, page);
  }

  finish(): ContractSection[] {
    this.close();
    return this.sections;
  }

  private close(): void {
    if (this.current === undefined) return;
    const text = normalizeWhitespace(this.current.lines.join(" "));
    if (text.length > 0) {
      const section: ContractSection = {
        fileName: this.fileName,
        sectionId: this.current.id,
        text,
        pages: [this.current.startPage, this.current.lastPage],
      };
      if (this.current.title !== undefined) section.title = this.current.title;
      this.sections.push(section);
    }
    this.current = undefined;
  }

  private open(id: string, page: number, title?: string): void {
    this.close();
    this.current = { id, title, lines: [], startPage: page, lastPage: page };
  }

  private append(line: string, page: number): void {
    if (this.current === undefined) return;
    this.current.lines.push(line);
    this.current.lastPage = page;
  }

  private openLetter(letter: string, page: number): void {
    this.open(`§${this.currentTop}(${letter})`, page);
    this.currentLetter = letter;
    this.expectedLetterCode += 1;
    this.expectedRoman = 1;
  }

  private decimalClause(trimmed: string, page: number): boolean {
    const decimal = DECIMAL_CLAUSE_RE.exec(trimmed);
    if (decimal === null) return false;
    this.open(`§${decimal[1]}.${decimal[2]}`, page);
    this.append(trimmed, page);
    return true;
  }

  private topHeading(trimmed: string, page: number): boolean {
    const top = TOP_HEADING_RE.exec(trimmed);
    if (top === null) return false;
    const number = Number(top[1]);
    // The first heading anchors the sequence at whatever number the
    // document starts with; later headings must continue it (+1).
    if (number > 20 || (this.expectedTop !== 0 && number !== this.expectedTop)) {
      return false;
    }
    this.open(`§${number}`, page, trimmed.slice(top[0].length - 1));
    this.expectedTop = number + 1;
    this.currentTop = number;
    this.currentLetter = "";
    this.expectedLetterCode = "a".charCodeAt(0);
    this.expectedRoman = 1;
    this.append(trimmed, page);
    return true;
  }

  private standaloneLetter(trimmed: string, page: number): boolean {
    const standalone = STANDALONE_LETTER_RE.exec(trimmed);
    if (
      standalone === null ||
      this.currentTop === 0 ||
      standalone[1] !== String.fromCharCode(this.expectedLetterCode)
    ) {
      return false;
    }
    this.openLetter(standalone[1] ?? "", page);
    return true;
  }

  private standaloneRoman(trimmed: string, page: number): boolean {
    const roman = STANDALONE_ROMAN_RE.exec(trimmed);
    if (
      roman === null ||
      this.currentLetter.length === 0 ||
      ROMAN_VALUES[roman[1] ?? ""] !== this.expectedRoman
    ) {
      return false;
    }
    this.open(`§${this.currentTop}(${this.currentLetter})(${roman[1]})`, page);
    this.expectedRoman += 1;
    return true;
  }

  // Inline letter markers "(a)" split the line: text before the marker
  // stays in the current section, the marker opens the next letter section.
  private inlineLetters(trimmed: string, page: number): boolean {
    if (this.currentTop === 0) return false;
    let remainder = trimmed;
    let handled = false;
    for (;;) {
      INLINE_LETTER_RE.lastIndex = 0;
      const match = INLINE_LETTER_RE.exec(remainder);
      if (match === null || match[1] !== String.fromCharCode(this.expectedLetterCode)) {
        break;
      }
      const before = remainder.slice(0, match.index).trim();
      if (before.length > 0) this.append(before, page);
      this.openLetter(match[1] ?? "", page);
      remainder = remainder.slice(match.index + match[0].length).trim();
      handled = true;
    }
    if (handled && remainder.length > 0) this.append(remainder, page);
    return handled;
  }
}

// Turn extracted page lines into labelled contract sections. Sections end at
// "IN WITNESS WHEREOF" so signature blocks never become sections, and lone
// page-number lines are dropped.
export function extractSections(fileName: string, pages: PdfPageLines[]): ContractSection[] {
  const sectionizer = new Sectionizer(fileName);
  for (const { page, lines } of pages) {
    if (sectionizer.done) break;
    for (const line of lines) {
      sectionizer.feed(line, page);
      if (sectionizer.done) break;
    }
  }
  return sectionizer.finish();
}
