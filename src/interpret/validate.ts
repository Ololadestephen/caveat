import { isRecord, keySetError } from "../shape.ts";
import { normalizeWhitespace } from "../text.ts";
import { QUOTE_MAX_LENGTH, REASON_MAX_LENGTH } from "./schema.ts";
import type { Decision, NeedsReviewReason, Question } from "./types.ts";

export type ValidationResult =
  | { ok: true; decision: Decision }
  | { ok: false; reason: NeedsReviewReason; detail: string; decision?: Decision };

const TOP_LEVEL_KEYS = ["action", "reason", "cited_clause", "confidence"];
const CLAUSE_KEYS = ["excerpt_id", "quote"];

// Verbatim checks run on whitespace-normalised text: contract text wraps
// mid-phrase, so a quote that spans a wrap still counts as verbatim.
export function quoteInText(quote: string, text: string): boolean {
  const normalizedQuote = normalizeWhitespace(quote);
  return normalizedQuote.length > 0 && normalizeWhitespace(text).includes(normalizedQuote);
}

export function validateDecision(
  parsed: unknown,
  question: Question,
  threshold: number,
): ValidationResult {
  const schemaFail = (detail: string): ValidationResult => ({
    ok: false,
    reason: "schema_mismatch",
    detail,
  });

  if (!isRecord(parsed)) {
    return schemaFail("decision is not a JSON object");
  }
  const topKeyError = keySetError(parsed, TOP_LEVEL_KEYS);
  if (topKeyError !== undefined) {
    return schemaFail(topKeyError);
  }

  const { action, reason, cited_clause: citedClause, confidence } = parsed;
  const actions = question.spec.actions;

  if (typeof action !== "string" || !actions.includes(action)) {
    return schemaFail(`action must be one of ${actions.join(", ")}`);
  }
  if (typeof reason !== "string" || reason.length === 0 || reason.length > REASON_MAX_LENGTH) {
    return schemaFail(`reason must be a non-empty string of at most ${REASON_MAX_LENGTH} characters`);
  }
  if (!isRecord(citedClause)) {
    return schemaFail("cited_clause is not a JSON object");
  }
  const clauseKeyError = keySetError(citedClause, CLAUSE_KEYS);
  if (clauseKeyError !== undefined) {
    return schemaFail(`cited_clause: ${clauseKeyError}`);
  }
  if (typeof citedClause.excerpt_id !== "string" || citedClause.excerpt_id.length === 0) {
    return schemaFail("cited_clause.excerpt_id must be a non-empty string");
  }
  if (typeof citedClause.quote !== "string" || citedClause.quote.length > QUOTE_MAX_LENGTH) {
    return schemaFail(`cited_clause.quote must be a string of at most ${QUOTE_MAX_LENGTH} characters`);
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return schemaFail("confidence must be a number between 0 and 1");
  }

  const decision: Decision = {
    action,
    reason,
    cited_clause: { excerpt_id: citedClause.excerpt_id, quote: citedClause.quote },
    confidence,
  };

  const excerpt = question.excerpts.find((e) => e.id === decision.cited_clause.excerpt_id);
  if (excerpt === undefined) {
    return {
      ok: false,
      reason: "unknown_excerpt",
      detail: `cited excerpt id ${JSON.stringify(decision.cited_clause.excerpt_id)} was not supplied`,
      decision,
    };
  }
  if (!quoteInText(decision.cited_clause.quote, excerpt.text)) {
    return {
      ok: false,
      reason: "quote_not_verbatim",
      detail: "cited quote is not a verbatim substring of the cited excerpt",
      decision,
    };
  }
  if (decision.action === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `provider reported ${question.spec.id} as ambiguous`,
      decision,
    };
  }
  if (decision.confidence < threshold) {
    return {
      ok: false,
      reason: "low_confidence",
      detail: `self-reported confidence ${decision.confidence} is below threshold ${threshold}`,
      decision,
    };
  }
  return { ok: true, decision };
}
