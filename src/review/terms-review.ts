import type { ContractSection } from "../evidence/sections.ts";
import type { TermKind, ValidatedTerm } from "../interpret/payment-terms.ts";
import { TERM_KINDS } from "../interpret/payment-terms.ts";
import { quoteInText } from "../interpret/validate.ts";
import { isRecord } from "../shape.ts";

// The reviewer-confirmation file for the generic path
// ($CAVEAT_PRIVATE/reviews/<profile reviewFileName>): one entry per extracted
// term, matched on kind + excerptId + quote verbatim in the section text.
export type TermReviewEntry = {
  kind: TermKind;
  excerptId: string;
  quote: string;
  decision: "confirm" | "reject";
  reviewer: string;
};

// A confirmed extracted term and who confirmed it.
export type TermDecision = {
  termId: string;
  kind: TermKind;
  excerptId: string;
  reviewer: string;
};

export type TermsReviewCheck =
  | {
      status: "confirmed";
      decisions: TermDecision[];
      // Entries that matched no extracted term — ignored, but listed.
      extras: TermReviewEntry[];
    }
  | {
      status: "needs_review";
      reason: "terms_unconfirmed" | "term_rejected" | "review_citation_invalid";
      detail: string;
      extras: TermReviewEntry[];
    };

type Sections = readonly Pick<
  ContractSection,
  "fileName" | "sectionId" | "text" | "title"
>[];

function fail(
  reason: "terms_unconfirmed" | "term_rejected" | "review_citation_invalid",
  detail: string,
  extras: TermReviewEntry[] = [],
): TermsReviewCheck {
  return { status: "needs_review", reason, detail, extras };
}

// Excerpt ids are "<fileName>#<sectionId>"; the section name after the '#'
// resolves by id or by heading title, like the other review files.
function entryText(
  sections: Sections,
  excerptId: string,
): { texts: string[]; fileName: string; section: string } {
  const split = excerptId.indexOf("#");
  const fileName = split === -1 ? excerptId : excerptId.slice(0, split);
  const section = split === -1 ? "" : excerptId.slice(split + 1);
  return {
    fileName,
    section,
    texts: sections
      .filter(
        (s) =>
          s.fileName === fileName && (s.sectionId === section || s.title === section),
      )
      .map((s) => s.text),
  };
}

// Validates the file's shape, verifies every entry's quote verbatim against
// the run's sections, then matches entries to the extracted terms. Every
// extracted term needs a matching confirm; a matching reject blocks the run.
export function validateTermsReview(
  raw: unknown,
  terms: ValidatedTerm[],
  sections: Sections,
): TermsReviewCheck {
  if (!isRecord(raw)) return fail("review_citation_invalid", "terms review is not a JSON object");
  const list = raw.terms;
  if (!Array.isArray(list)) {
    return fail("review_citation_invalid", "terms review: terms must be an array");
  }

  const entries: TermReviewEntry[] = [];
  for (const [i, item] of list.entries()) {
    const path = `terms[${i}]`;
    if (!isRecord(item)) return fail("review_citation_invalid", `${path}: expected an object`);
    const kind = item.kind;
    const excerptId = item.excerptId;
    const quote = item.quote;
    const decision = item.decision;
    const reviewer = item.reviewer;
    if (typeof kind !== "string" || !TERM_KINDS.includes(kind as TermKind)) {
      return fail("review_citation_invalid", `${path}.kind is not a known term kind`);
    }
    for (const [key, value] of [
      ["excerptId", excerptId],
      ["quote", quote],
      ["reviewer", reviewer],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        return fail("review_citation_invalid", `${path}.${key} must be a non-empty string`);
      }
    }
    if (decision !== "confirm" && decision !== "reject") {
      return fail(
        "review_citation_invalid",
        `${path}.decision must be "confirm" or "reject"`,
      );
    }
    const { texts, fileName, section } = entryText(sections, excerptId as string);
    if (texts.length === 0) {
      return fail(
        "review_citation_invalid",
        `${path}: no extracted section ${section} in ${fileName}`,
      );
    }
    if (!texts.some((text) => quoteInText(quote as string, text))) {
      return fail(
        "review_citation_invalid",
        `${path}: quote is not verbatim in ${fileName} ${section}`,
      );
    }
    entries.push({
      kind: kind as TermKind,
      excerptId: excerptId as string,
      quote: quote as string,
      decision,
      reviewer: reviewer as string,
    });
  }

  // Match each extracted term to an entry on kind + excerptId + quote.
  const matched = new Set<number>();
  const decisions: TermDecision[] = [];
  const missing: string[] = [];
  for (const term of terms) {
    const idx = entries.findIndex(
      (e, i) =>
        !matched.has(i) &&
        e.kind === term.kind &&
        e.excerptId === term.excerptId &&
        e.quote === term.quote,
    );
    if (idx === -1) {
      missing.push(term.id);
      continue;
    }
    matched.add(idx);
    const entry = entries[idx]!;
    if (entry.decision === "reject") {
      return fail(
        "term_rejected",
        `${term.id} was rejected by ${entry.reviewer} (${entry.excerptId})`,
        entries.filter((_, i) => !matched.has(i)),
      );
    }
    decisions.push({
      termId: term.id,
      kind: term.kind,
      excerptId: term.excerptId,
      reviewer: entry.reviewer,
    });
  }
  const extras = entries.filter((_, i) => !matched.has(i));
  if (missing.length > 0) {
    return fail(
      "terms_unconfirmed",
      `no confirmed review entry for ${missing.join(", ")}`,
      extras,
    );
  }
  return { status: "confirmed", decisions, extras };
}
