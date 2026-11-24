import type { ContractSection } from "../evidence/sections.ts";
import { quoteInText } from "../interpret/validate.ts";

export type ReviewCitation = {
  fileName: string;
  section: string;
  quote: string;
};

// A field in the reviewer's "continues" reading: a display text that must sit
// verbatim inside a quote that sits verbatim in the named section.
export type ReadingCitation = {
  text: string;
  fileName: string;
  section: string;
  quote: string;
};

export type RetainerReview = {
  questionId: string;
  reviewer: string;
  reviewedAt: string;
  baseRetainer: {
    answer: string;
    note: string | undefined;
    citations: ReviewCitation[];
    continuesReading:
      | { amount: ReadingCitation; payDay: ReadingCitation; termEnd: ReadingCitation }
      | undefined;
  };
  firstAmendmentPay: {
    answer: string;
    cashEffectInWindow: string | undefined;
    note: string | undefined;
    citations: ReviewCitation[];
  };
};

export type SourcedOverride = {
  questionId: string;
  answer: string;
  citations: ReviewCitation[];
  reviewer: string;
  reviewedAt: string;
};

export type ReviewValidation<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "review_citation_invalid"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const value = obj[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0) return { ok: false };
  return { ok: true, value };
}

type Sections = readonly Pick<ContractSection, "fileName" | "sectionId" | "text">[];

function sectionText(sections: Sections, fileName: string, sectionId: string): string | undefined {
  return sections.find((s) => s.fileName === fileName && s.sectionId === sectionId)?.text;
}

function invalid(detail: string): ReviewValidation<never> {
  return { ok: false, reason: "review_citation_invalid", detail };
}

function parseCitations(
  value: unknown,
  path: string,
  sections: Sections,
): { citations: ReviewCitation[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${path}: expected a non-empty array of citations` };
  }
  const citations: ReviewCitation[] = [];
  for (const [i, item] of value.entries()) {
    const p = `${path}[${i}]`;
    if (!isRecord(item)) return { error: `${p}: expected an object` };
    const fileName = reqString(item, "fileName");
    const section = reqString(item, "section");
    const quote = reqString(item, "quote");
    if (fileName === undefined || section === undefined || quote === undefined) {
      return { error: `${p}: fileName, section and quote must be non-empty strings` };
    }
    const text = sectionText(sections, fileName, section);
    if (text === undefined) {
      return { error: `${p}: no extracted section ${section} in ${fileName}` };
    }
    if (!quoteInText(quote, text)) {
      return { error: `${p}: quote is not verbatim in ${fileName} ${section}` };
    }
    citations.push({ fileName, section, quote });
  }
  return { citations };
}

function parseReadingCitation(
  value: unknown,
  path: string,
  sections: Sections,
): { citation: ReadingCitation } | { error: string } {
  if (!isRecord(value)) return { error: `${path}: expected an object` };
  const text = reqString(value, "text");
  const fileName = reqString(value, "fileName");
  const section = reqString(value, "section");
  const quote = reqString(value, "quote");
  if (text === undefined || fileName === undefined || section === undefined || quote === undefined) {
    return { error: `${path}: text, fileName, section and quote must be non-empty strings` };
  }
  const sectionBody = sectionText(sections, fileName, section);
  if (sectionBody === undefined) {
    return { error: `${path}: no extracted section ${section} in ${fileName}` };
  }
  if (!quoteInText(quote, sectionBody)) {
    return { error: `${path}: quote is not verbatim in ${fileName} ${section}` };
  }
  if (!quoteInText(text, quote)) {
    return { error: `${path}: text is not verbatim within its quote` };
  }
  return { citation: { text, fileName, section, quote } };
}

// Validates the retainer review record's shape and verifies every citation
// quote verbatim (whitespace-normalised) against the extracted section text.
// Any failure blocks the run with reason review_citation_invalid.
export function validateRetainerReview(
  raw: unknown,
  sections: Sections,
): ReviewValidation<RetainerReview> {
  if (!isRecord(raw)) return invalid("retainer review is not a JSON object");
  const questionId = reqString(raw, "questionId");
  const reviewer = reqString(raw, "reviewer");
  const reviewedAt = reqString(raw, "reviewedAt");
  if (questionId === undefined || reviewer === undefined || reviewedAt === undefined) {
    return invalid("questionId, reviewer and reviewedAt must be non-empty strings");
  }

  const base = raw.baseRetainer;
  if (!isRecord(base)) return invalid("baseRetainer must be an object");
  const baseAnswer = reqString(base, "answer");
  if (baseAnswer === undefined) return invalid("baseRetainer.answer must be a non-empty string");
  const baseCitations = parseCitations(base.citations, "baseRetainer.citations", sections);
  if ("error" in baseCitations) return invalid(baseCitations.error);

  let continuesReading: RetainerReview["baseRetainer"]["continuesReading"];
  if (base.continuesReading !== undefined) {
    if (!isRecord(base.continuesReading)) {
      return invalid("baseRetainer.continuesReading must be an object");
    }
    const amount = parseReadingCitation(
      base.continuesReading.amount,
      "baseRetainer.continuesReading.amount",
      sections,
    );
    if ("error" in amount) return invalid(amount.error);
    const payDay = parseReadingCitation(
      base.continuesReading.payDay,
      "baseRetainer.continuesReading.payDay",
      sections,
    );
    if ("error" in payDay) return invalid(payDay.error);
    const termEnd = parseReadingCitation(
      base.continuesReading.termEnd,
      "baseRetainer.continuesReading.termEnd",
      sections,
    );
    if ("error" in termEnd) return invalid(termEnd.error);
    continuesReading = {
      amount: amount.citation,
      payDay: payDay.citation,
      termEnd: termEnd.citation,
    };
  }

  const first = raw.firstAmendmentPay;
  if (!isRecord(first)) return invalid("firstAmendmentPay must be an object");
  const firstAnswer = reqString(first, "answer");
  if (firstAnswer === undefined) return invalid("firstAmendmentPay.answer must be a non-empty string");
  const firstCitations = parseCitations(
    first.citations,
    "firstAmendmentPay.citations",
    sections,
  );
  if ("error" in firstCitations) return invalid(firstCitations.error);

  const baseNote = optString(base, "note");
  const firstCash = optString(first, "cashEffectInWindow");
  const firstNote = optString(first, "note");
  if (!baseNote.ok || !firstCash.ok || !firstNote.ok) {
    return invalid("note and cashEffectInWindow must be non-empty strings when present");
  }

  return {
    ok: true,
    value: {
      questionId,
      reviewer,
      reviewedAt,
      baseRetainer: {
        answer: baseAnswer,
        note: baseNote.value,
        citations: baseCitations.citations,
        continuesReading,
      },
      firstAmendmentPay: {
        answer: firstAnswer,
        cashEffectInWindow: firstCash.value,
        note: firstNote.value,
        citations: firstCitations.citations,
      },
    },
  };
}

// A generic sourced override that can resolve a needs_review decision; the
// same verbatim citation check applies.
export function validateSourcedOverride(
  raw: unknown,
  sections: Sections,
): ReviewValidation<SourcedOverride> {
  if (!isRecord(raw)) return invalid("override is not a JSON object");
  const questionId = reqString(raw, "questionId");
  const answer = reqString(raw, "answer");
  const reviewer = reqString(raw, "reviewer");
  const reviewedAt = reqString(raw, "reviewedAt");
  if (
    questionId === undefined ||
    answer === undefined ||
    reviewer === undefined ||
    reviewedAt === undefined
  ) {
    return invalid("questionId, answer, reviewer and reviewedAt must be non-empty strings");
  }
  const citations = parseCitations(raw.citations, "citations", sections);
  if ("error" in citations) return invalid(citations.error);
  return {
    ok: true,
    value: { questionId, answer, citations: citations.citations, reviewer, reviewedAt },
  };
}
