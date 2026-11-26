import { isRecord, keySetError } from "../shape.ts";
import { normalizeWhitespace, parseMonthDayYear } from "../text.ts";
import { callStructuredChat, chatConfig, modelInfo } from "./chat.ts";
import { excerptTags, DECISION_SYSTEM_PROMPT } from "./prompt.ts";
import { parseAmountCents } from "./schedule.ts";
import { quoteInText } from "./validate.ts";
import type { Excerpt, NeedsReviewOutcome, NeedsReviewReason } from "./types.ts";
import type { OpenRouterProviderConfig } from "./openrouter.ts";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;

export const TERM_KINDS = [
  "fixed_date_payment",
  "deposit",
  "payment_terms",
  "escrow_release",
] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const TERM_KIND_LABELS: Record<TermKind, string> = {
  fixed_date_payment: "fixed-date payment",
  deposit: "deposit",
  payment_terms: "payment terms",
  escrow_release: "escrow release",
};

const TERM_FIELDS = [
  "kind",
  "amount_text",
  "date_text",
  "recurrence_text",
  "net_days_text",
  "excerpt_id",
  "quote",
  "date_excerpt_id",
  "date_quote",
];

const BOUND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "excerpt_id", "quote"],
  properties: {
    text: { type: "string" },
    excerpt_id: { type: "string" },
    quote: { type: "string" },
  },
} as const;

export const PAYMENT_TERMS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["terms", "term_start", "term_end", "confidence"],
  properties: {
    terms: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: TERM_FIELDS,
        properties: {
          kind: { type: "string", enum: [...TERM_KINDS] },
          amount_text: { type: ["string", "null"] },
          date_text: { type: ["string", "null"] },
          recurrence_text: { type: ["string", "null"] },
          net_days_text: { type: ["string", "null"] },
          excerpt_id: { type: "string" },
          quote: { type: "string" },
          date_excerpt_id: { type: ["string", "null"] },
          date_quote: { type: ["string", "null"] },
        },
      },
    },
    term_start: { anyOf: [{ type: "null" }, BOUND_SCHEMA] },
    term_end: { anyOf: [{ type: "null" }, BOUND_SCHEMA] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

// The staged bounds-only extraction, sent over the Jev-picked term clause (or
// every excerpt when the pick is not confident). The main schema must stay
// byte-stable for the digest, so this is a separate schema.
export const TERM_BOUNDS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["term_start", "term_end", "confidence"],
  properties: {
    term_start: { anyOf: [{ type: "null" }, BOUND_SCHEMA] },
    term_end: { anyOf: [{ type: "null" }, BOUND_SCHEMA] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const PAYMENT_TERMS_USER_PROMPT = `Extract every term in these excerpts that sets when the consultant is paid in cash, exactly as written, as a list of terms. kind is one of: fixed_date_payment (an amount paid or invoiced on a stated date or on a stated day of each month: amount_text, recurrence_text such as "per month" when it repeats, and date_text for the date or the day-of-month rule), deposit (an amount paid at signing or before work starts: amount_text and date_text), payment_terms (how long after an invoice payment is due: net_days_text only), escrow_release (an amount released from escrow on a date: amount_text and date_text). Leave fields a kind does not use as null. quote and excerpt_id: the sentence stating the amount (or, for payment_terms, the days) and its excerpt. When a term's date or day-of-month rule is stated in a different excerpt from its amount, copy that sentence into date_quote and its excerpt id into date_excerpt_id; otherwise set both to null. Also give term_start and term_end: the dates the agreement's term starts and ends, exactly as written, usually in a section about the term of the agreement, or null if not stated. Every text value must be copied verbatim from its quote, and every quote verbatim from one supplied excerpt. Do not include equity, stock, expenses or reimbursements. Do not add, total, or convert amounts or dates.`;

export const TERM_BOUNDS_USER_PROMPT = `Give the dates this agreement's term starts and ends, exactly as written. term_start: the date the term commences; term_end: the date it terminates or expires. Copy each date verbatim from its quote, and each quote verbatim from one supplied excerpt; excerpt_id is that excerpt's id. If either date is not stated, set it to null.`;

// What a term's date_text can parse to: a concrete calendar date, or a
// day-of-month rule for a recurring term.
export type TermDate =
  | { kind: "date"; iso: string; dayNum: number }
  | { kind: "month_end" }
  | { kind: "month_day"; day: number };

const MONTH_END_RE = /last day of (the )?(invoiced |each |calendar )?month/i;
const FIRST_DAY_RE = /(1st|first) (day )?of (each|the) month/i;

export function parseTermDate(text: string): TermDate | undefined {
  const date = parseMonthDayYear(text);
  if (date !== undefined) return { kind: "date", ...date };
  if (MONTH_END_RE.test(text)) return { kind: "month_end" };
  if (FIRST_DAY_RE.test(text)) return { kind: "month_day", day: 1 };
  return undefined;
}

const RECURRENCE_RE = /per month|monthly|each month/i;

export function parseRecurrence(text: string | null): "monthly" | "one_off" | undefined {
  if (text === null) return "one_off";
  if (RECURRENCE_RE.test(text)) return "monthly";
  return undefined;
}

const NET_DAYS_RES = [
  /net (\d{1,2})\b/i,
  /\((\d{1,2})\)\s*(calendar )?days/i,
  /\b(\d{1,2})\s+(calendar )?days\b/i,
];

export function parseNetDays(text: string): number | undefined {
  for (const re of NET_DAYS_RES) {
    const match = re.exec(text);
    if (match === null) continue;
    const days = Number(match[1]);
    if (days >= 1 && days <= 120) return days;
  }
  return undefined;
}

export type TermBound = {
  text: string;
  iso: string;
  dayNum: number;
  excerptId: string;
  quote: string;
};

export type ValidatedTerm = {
  // term-N, numbered in document order.
  id: string;
  kind: TermKind;
  amountText: string | null;
  amountCents: number | null;
  dateText: string | null;
  date: TermDate | null;
  recurrenceText: string | null;
  recurrence: "monthly" | "one_off";
  netDaysText: string | null;
  netDays: number | null;
  excerptId: string;
  quote: string;
  // Set when the term's date text is cited from a different excerpt than its
  // amount — both null when the one quote carries everything.
  dateExcerptId: string | null;
  dateQuote: string | null;
};

export type ValidatedPaymentTerms = {
  terms: ValidatedTerm[];
  termStart: TermBound | null;
  termEnd: TermBound | null;
  confidence: number;
  // Set when the bounds came from the staged term_bounds pass rather than the
  // main extraction — boundsPick is the Jev term_clause answer that chose the
  // clause excerpt (with its probabilities), absent without a TypeSafe
  // connection.
  boundsFrom?: "term_bounds";
  boundsPick?: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
    model: string;
    usage?: unknown;
  };
};

// A recurring term needs both bounds to expand into invoices.
export function needsTermBounds(terms: ValidatedPaymentTerms): boolean {
  return (
    terms.terms.some((t) => t.recurrence === "monthly") &&
    (terms.termStart === null || terms.termEnd === null)
  );
}

export type PaymentTermsValidation =
  | { ok: true; terms: ValidatedPaymentTerms }
  | { ok: false; reason: NeedsReviewReason; detail: string; partial?: ValidatedPaymentTerms };

export type PaymentTermsOutcome =
  | {
      status: "extracted";
      terms: ValidatedPaymentTerms;
      provider: string;
      model: string;
      modelVersion?: string;
      servedBy?: string;
      latencyMs: number;
      // Set when this outcome was reused verbatim from an earlier run.
      carriedFrom?: string;
    }
  // Validation failures that still produced terms carry them on partialTerms
  // (missing bounds, low confidence) so a blocked receipt shows what was read.
  | (NeedsReviewOutcome & { partialTerms?: ValidatedPaymentTerms });

export type TermBoundsOutcome =
  | {
      status: "extracted";
      termStart: TermBound | null;
      termEnd: TermBound | null;
      confidence: number;
      provider: string;
      model: string;
      modelVersion?: string;
      servedBy?: string;
      latencyMs: number;
    }
  | NeedsReviewOutcome;

type Invalid = Extract<PaymentTermsValidation, { ok: false }> & {
  partial?: ValidatedPaymentTerms;
};

function invalid(reason: NeedsReviewReason, detail: string, partial?: ValidatedPaymentTerms): Invalid {
  return { ok: false, reason, detail, ...(partial !== undefined ? { partial } : {}) };
}

type ExcerptIndex = Map<string, { index: number; text: string }>;

// The fields each kind uses; any other field must be null. A
// fixed_date_payment may carry only an amount ("$5,000.00 per month") or only
// a timing clause ("on the last day of the invoiced month") — the builder
// pairs them — so at least one of amount_text/date_text must be present.
const KIND_FIELDS: Record<
  TermKind,
  { required: string[]; optional: string[]; atLeastOne?: string[] }
> = {
  fixed_date_payment: {
    required: [],
    optional: ["amount_text", "date_text", "recurrence_text"],
    atLeastOne: ["amount_text", "date_text"],
  },
  deposit: { required: ["amount_text", "date_text"], optional: [] },
  payment_terms: { required: ["net_days_text"], optional: [] },
  escrow_release: { required: ["amount_text", "date_text"], optional: [] },
};

type RawTerm = {
  kind: TermKind;
  amount_text: string | null;
  date_text: string | null;
  recurrence_text: string | null;
  net_days_text: string | null;
  excerpt_id: string;
  quote: string;
  date_excerpt_id: string | null;
  date_quote: string | null;
};

// Only kinds whose term carries a date may split that date's citation into a
// second excerpt; payment_terms never does.
const DATE_CITATION_KINDS: readonly TermKind[] = [
  "fixed_date_payment",
  "deposit",
  "escrow_release",
];

function checkFieldVerbatim(
  fieldValue: unknown,
  path: string,
  quote: string,
): Invalid | undefined {
  if (fieldValue === null) return undefined;
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    return invalid("schema_mismatch", `${path} must be a string or null`);
  }
  if (!quoteInText(fieldValue, quote)) {
    return invalid("quote_not_verbatim", `${path} is not verbatim within its quote`);
  }
  return undefined;
}

function rawTerms(value: unknown, excerptById: ExcerptIndex): { ok: true; value: RawTerm[] } | Invalid {
  if (!Array.isArray(value)) return invalid("schema_mismatch", "terms is not an array");
  if (value.length < 1 || value.length > 12) {
    return invalid("schema_mismatch", "terms must contain between 1 and 12 items");
  }
  const terms: RawTerm[] = [];
  for (const [i, item] of value.entries()) {
    const path = `terms[${i}]`;
    if (!isRecord(item)) return invalid("schema_mismatch", `${path} is not a JSON object`);
    const keys = keySetError(item, TERM_FIELDS);
    if (keys !== undefined) return invalid("schema_mismatch", `${path}: ${keys}`);
    const term = item as unknown as RawTerm;
    if (!TERM_KINDS.includes(term.kind)) {
      return invalid("schema_mismatch", `${path}.kind ${JSON.stringify(term.kind)} is not a known term kind`);
    }
    if (typeof term.excerpt_id !== "string" || term.excerpt_id.length === 0) {
      return invalid("schema_mismatch", `${path}.excerpt_id must be a non-empty string`);
    }
    if (typeof term.quote !== "string" || term.quote.length === 0) {
      return invalid("schema_mismatch", `${path}.quote must be a non-empty string`);
    }
    const excerpt = excerptById.get(term.excerpt_id);
    if (excerpt === undefined) {
      return invalid(
        "unknown_excerpt",
        `${path} cites excerpt id ${JSON.stringify(term.excerpt_id)} which was not supplied`,
      );
    }
    if (!quoteInText(term.quote, excerpt.text)) {
      return invalid("quote_not_verbatim", `${path}.quote is not verbatim in its cited excerpt`);
    }
    // The split citation: date_excerpt_id/date_quote come as a pair, only on
    // kinds that carry a date, and the pair must resolve verbatim — then
    // date_text is checked against date_quote instead of quote.
    const hasDateQuote = term.date_excerpt_id !== null || term.date_quote !== null;
    let dateVerbatimIn = term.quote;
    if (hasDateQuote) {
      if (!DATE_CITATION_KINDS.includes(term.kind)) {
        return invalid("schema_mismatch", `${path}: date_excerpt_id/date_quote must be null for kind ${term.kind}`);
      }
      if (term.date_excerpt_id === null || term.date_quote === null) {
        return invalid("schema_mismatch", `${path}: date_excerpt_id and date_quote must be set together`);
      }
      for (const [key, value] of [
        ["date_excerpt_id", term.date_excerpt_id],
        ["date_quote", term.date_quote],
      ] as const) {
        if (typeof value !== "string" || value.length === 0) {
          return invalid("schema_mismatch", `${path}.${key} must be a non-empty string or null`);
        }
      }
      const dateExcerpt = excerptById.get(term.date_excerpt_id);
      if (dateExcerpt === undefined) {
        return invalid(
          "unknown_excerpt",
          `${path}.date_excerpt_id cites excerpt id ${JSON.stringify(term.date_excerpt_id)} which was not supplied`,
        );
      }
      if (!quoteInText(term.date_quote, dateExcerpt.text)) {
        return invalid("quote_not_verbatim", `${path}.date_quote is not verbatim in its cited excerpt`);
      }
      if (term.date_text === null) {
        return invalid("schema_mismatch", `${path}.date_text is required when date_quote is set`);
      }
      dateVerbatimIn = term.date_quote;
    }
    // Field set per kind: required present, unused null, every text verbatim.
    const spec = KIND_FIELDS[term.kind];
    for (const field of ["amount_text", "date_text", "recurrence_text", "net_days_text"]) {
      const fieldValue = term[field as "amount_text"];
      const used = spec.required.includes(field) || spec.optional.includes(field);
      if (!used) {
        if (fieldValue !== null) {
          return invalid("schema_mismatch", `${path}.${field} must be null for kind ${term.kind}`);
        }
        continue;
      }
      if (spec.required.includes(field) && fieldValue === null) {
        return invalid("schema_mismatch", `${path}.${field} is required for kind ${term.kind}`);
      }
      const bad = checkFieldVerbatim(
        fieldValue,
        `${path}.${field}`,
        field === "date_text" ? dateVerbatimIn : term.quote,
      );
      if (bad !== undefined) return bad;
    }
    if (
      spec.atLeastOne !== undefined &&
      spec.atLeastOne.every((f) => term[f as "amount_text"] === null)
    ) {
      return invalid(
        "schema_mismatch",
        `${path} needs at least one of ${spec.atLeastOne.join(", ")} for kind ${term.kind}`,
      );
    }
    terms.push(term);
  }
  return { ok: true, value: terms };
}

// One {text, excerpt_id, quote} field or null; null is a valid "not stated".
function boundField(
  parsed: Record<string, unknown>,
  name: "term_start" | "term_end",
  excerptById: ExcerptIndex,
): { ok: true; value: { text: string; excerpt_id: string; quote: string } | null } | Invalid {
  const field = parsed[name];
  if (field === null) return { ok: true, value: null };
  if (!isRecord(field)) return invalid("schema_mismatch", `${name} is not a JSON object or null`);
  const keys = keySetError(field, ["text", "excerpt_id", "quote"]);
  if (keys !== undefined) return invalid("schema_mismatch", `${name}: ${keys}`);
  const bound = field as unknown as { text: string; excerpt_id: string; quote: string };
  for (const key of ["text", "excerpt_id", "quote"] as const) {
    if (typeof bound[key] !== "string" || bound[key].length === 0) {
      return invalid("schema_mismatch", `${name}.${key} must be a non-empty string`);
    }
  }
  const excerpt = excerptById.get(bound.excerpt_id);
  if (excerpt === undefined) {
    return invalid(
      "unknown_excerpt",
      `${name} cites excerpt id ${JSON.stringify(bound.excerpt_id)} which was not supplied`,
    );
  }
  if (!quoteInText(bound.quote, excerpt.text)) {
    return invalid("quote_not_verbatim", `${name}.quote is not verbatim in its cited excerpt`);
  }
  if (!quoteInText(bound.text, bound.quote)) {
    return invalid("quote_not_verbatim", `${name}.text is not verbatim within its quote`);
  }
  return { ok: true, value: bound };
}

function parseBound(
  name: string,
  raw: { text: string; excerpt_id: string; quote: string } | null,
): { ok: true; value: TermBound | null } | Invalid {
  if (raw === null) return { ok: true, value: null };
  const date = parseMonthDayYear(raw.text);
  if (date === undefined) {
    return invalid(
      "schema_mismatch",
      `${name}.text ${JSON.stringify(raw.text)} is not a "Month D, YYYY" date`,
    );
  }
  return {
    ok: true,
    value: { text: raw.text, ...date, excerptId: raw.excerpt_id, quote: raw.quote },
  };
}

function buildTerm(term: RawTerm, id: string): { ok: true; value: ValidatedTerm } | Invalid {
  let amountCents: number | null = null;
  if (term.amount_text !== null) {
    const cents = parseAmountCents(term.amount_text);
    if (cents === undefined) {
      // A fixed_date_payment may name its amount ("the Fees") — the cash
      // figure comes from the recurring fee term at input-building time.
      // Deposit and escrow amounts drive cash directly, so they must parse.
      if (term.kind !== "fixed_date_payment") {
        return invalid(
          "schema_mismatch",
          `term ${id} amount_text ${JSON.stringify(term.amount_text)} is not a dollar amount like "$1,234"`,
        );
      }
    } else {
      amountCents = cents;
    }
  }
  let date: TermDate | null = null;
  let dateAsRecurrence = false;
  if (term.date_text !== null) {
    const parsed = parseTermDate(term.date_text);
    if (parsed === undefined) {
      // "per month" is a recurrence phrase, not a date — the model may put it
      // in date_text for an amount-with-recurrence clause like §3.1.
      if (term.kind === "fixed_date_payment" && RECURRENCE_RE.test(term.date_text)) {
        dateAsRecurrence = true;
      } else {
        return invalid(
          "schema_mismatch",
          `term ${id} date_text ${JSON.stringify(term.date_text)} is not a "Month D, YYYY" date or a day-of-month rule`,
        );
      }
    } else {
      date = parsed;
    }
  }
  const recurrence = parseRecurrence(term.recurrence_text);
  if (recurrence === undefined) {
    return invalid(
      "schema_mismatch",
      `term ${id} recurrence_text ${JSON.stringify(term.recurrence_text)} is not a monthly recurrence`,
    );
  }
  const effectiveRecurrence = dateAsRecurrence ? "monthly" : recurrence;
  let netDays: number | null = null;
  if (term.net_days_text !== null) {
    const days = parseNetDays(term.net_days_text);
    if (days === undefined) {
      return invalid(
        "schema_mismatch",
        `term ${id} net_days_text ${JSON.stringify(term.net_days_text)} is not a "net <n> days" or "(<n>) days" term`,
      );
    }
    netDays = days;
  }
  return {
    ok: true,
    value: {
      id,
      kind: term.kind,
      amountText: term.amount_text,
      amountCents,
      dateText: term.date_text,
      date,
      recurrenceText: term.recurrence_text ?? (dateAsRecurrence ? term.date_text : null),
      recurrence: effectiveRecurrence,
      netDaysText: term.net_days_text,
      netDays,
      excerptId: term.excerpt_id,
      quote: term.quote,
      dateExcerptId: term.date_excerpt_id,
      dateQuote: term.date_quote,
    },
  };
}

// Validates one parsed payment-terms extraction: schema shape first, then the
// verbatim chain (each text inside its quote, each quote inside its cited
// excerpt, whitespace-normalised), then field sets per kind, parsers,
// confidence, and the consistency checks. Term ids are assigned here from
// document position, never from the model's array order.
export function validatePaymentTermsExtraction(
  parsed: unknown,
  excerpts: Excerpt[],
  threshold: number,
): PaymentTermsValidation {
  if (!isRecord(parsed)) {
    return invalid("schema_mismatch", "extraction is not a JSON object");
  }
  const topError = keySetError(parsed, ["terms", "term_start", "term_end", "confidence"]);
  if (topError !== undefined) return invalid("schema_mismatch", topError);

  const excerptById: ExcerptIndex = new Map(
    excerpts.map((e, index) => [e.id, { index, text: e.text }]),
  );

  const termsOut = rawTerms(parsed.terms, excerptById);
  if (!termsOut.ok) return termsOut;

  const startOut = boundField(parsed, "term_start", excerptById);
  if (!startOut.ok) return startOut;
  const endOut = boundField(parsed, "term_end", excerptById);
  if (!endOut.ok) return endOut;

  const confidence = parsed.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return invalid("schema_mismatch", "confidence must be a number between 0 and 1");
  }

  const termStart = parseBound("term_start", startOut.value);
  if (!termStart.ok) return termStart;
  const termEnd = parseBound("term_end", endOut.value);
  if (!termEnd.ok) return termEnd;

  // Number the terms by document position.
  const positioned = termsOut.value.map((term, index) => {
    const excerpt = excerptById.get(term.excerpt_id);
    const quotePos =
      excerpt === undefined
        ? -1
        : normalizeWhitespace(excerpt.text).indexOf(normalizeWhitespace(term.quote));
    return { term, index, excerptIndex: excerpt?.index ?? -1, quotePos };
  });
  positioned.sort(
    (a, b) => a.excerptIndex - b.excerptIndex || a.quotePos - b.quotePos || a.index - b.index,
  );

  const terms: ValidatedTerm[] = [];
  const netDaysSeen = new Set<number>();
  for (const [i, entry] of positioned.entries()) {
    const built = buildTerm(entry.term, `term-${i + 1}`);
    if (!built.ok) return built;
    terms.push(built.value);
    if (built.value.kind === "payment_terms" && built.value.netDays !== null) {
      netDaysSeen.add(built.value.netDays);
    }
  }

  if (netDaysSeen.size > 1) {
    return invalid(
      "inconsistent_terms",
      `payment_terms entries disagree on the net-days value: ${[...netDaysSeen].join(", ")}`,
    );
  }

  const partial: ValidatedPaymentTerms = {
    terms,
    termStart: termStart.value,
    termEnd: termEnd.value,
    confidence,
  };

  if (confidence < threshold) {
    return invalid(
      "low_confidence",
      `self-reported confidence ${confidence} is below threshold ${threshold}`,
      partial,
    );
  }

  const recurring = terms.filter((t) => t.recurrence === "monthly");
  if (recurring.length > 0 && (termStart.value === null || termEnd.value === null)) {
    return invalid(
      "missing_term_bounds",
      `term ${recurring[0]?.id} recurs monthly but term_start or term_end is not stated`,
      partial,
    );
  }

  return {
    ok: true,
    terms: partial,
  };
}

// The staged bounds-only extraction: same bound shape and verbatim chain as
// the main extraction's term_start/term_end, minus the term list — either
// bound may still come back null, which the caller treats as still missing.
export function validateTermBoundsExtraction(
  parsed: unknown,
  excerpts: Excerpt[],
  threshold: number,
):
  | { ok: true; termStart: TermBound | null; termEnd: TermBound | null; confidence: number }
  | Invalid {
  if (!isRecord(parsed)) {
    return invalid("schema_mismatch", "bounds extraction is not a JSON object");
  }
  const topError = keySetError(parsed, ["term_start", "term_end", "confidence"]);
  if (topError !== undefined) return invalid("schema_mismatch", topError);

  const excerptById: ExcerptIndex = new Map(
    excerpts.map((e, index) => [e.id, { index, text: e.text }]),
  );

  const startOut = boundField(parsed, "term_start", excerptById);
  if (!startOut.ok) return startOut;
  const endOut = boundField(parsed, "term_end", excerptById);
  if (!endOut.ok) return endOut;

  const confidence = parsed.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return invalid("schema_mismatch", "confidence must be a number between 0 and 1");
  }

  const termStart = parseBound("term_start", startOut.value);
  if (!termStart.ok) return termStart;
  const termEnd = parseBound("term_end", endOut.value);
  if (!termEnd.ok) return termEnd;

  if (confidence < threshold) {
    return invalid(
      "low_confidence",
      `self-reported confidence ${confidence} is below threshold ${threshold}`,
    );
  }

  return { ok: true, termStart: termStart.value, termEnd: termEnd.value, confidence };
}

export class OpenRouterPaymentTermsExtractor {
  readonly name = "openrouter";
  private readonly gatewayBaseUrl: string;
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly allowedModelVersions: string[] | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenRouterProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl;
    this.model = config.model ?? "nvidia/nemotron-3.5-super-vl:free";
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowedModelVersions = config.allowedModelVersions;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async extract(
    question: { id: string; excerpts: Excerpt[] },
    options?: { signal?: AbortSignal },
  ): Promise<PaymentTermsOutcome> {
    const userPrompt = `${PAYMENT_TERMS_USER_PROMPT}\n\n${excerptTags(question.excerpts)}`;
    const result = await callStructuredChat(
      chatConfig(this.gatewayBaseUrl, this.timeoutMs, this.allowedModelVersions, this.fetchImpl),
      {
        model: this.model,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        userPrompt,
        schemaName: "payment_terms",
        schema: PAYMENT_TERMS_JSON_SCHEMA,
      },
      options,
    );

    const failOutcome = (
      reason: NeedsReviewReason,
      detail: string,
      extra?: { modelVersion?: string; servedBy?: string },
    ): Extract<PaymentTermsOutcome, { status: "needs_review" }> => ({
      status: "needs_review",
      reason,
      detail,
      provider: this.name,
      model: this.model,
      ...extra,
    });

    if (!result.ok) {
      return failOutcome(result.reason, result.detail, modelInfo(result));
    }
    const validation = validatePaymentTermsExtraction(
      result.parsed,
      question.excerpts,
      this.threshold,
    );
    if (!validation.ok) {
      const outcome = failOutcome(validation.reason, validation.detail, modelInfo(result));
      if (validation.partial !== undefined) outcome.partialTerms = validation.partial;
      return outcome;
    }
    return {
      status: "extracted",
      terms: validation.terms,
      provider: this.name,
      model: this.model,
      ...modelInfo(result),
      latencyMs: result.latencyMs,
    };
  }

  // The staged bounds pass: one small call over the Jev-picked excerpt (or
  // all of them). Separate schema and prompt so the main extraction's digest
  // is untouched.
  async extractTermBounds(
    excerpts: Excerpt[],
    options?: { signal?: AbortSignal },
  ): Promise<TermBoundsOutcome> {
    const userPrompt = `${TERM_BOUNDS_USER_PROMPT}\n\n${excerptTags(excerpts)}`;
    const result = await callStructuredChat(
      chatConfig(this.gatewayBaseUrl, this.timeoutMs, this.allowedModelVersions, this.fetchImpl),
      {
        model: this.model,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        userPrompt,
        schemaName: "term_bounds",
        schema: TERM_BOUNDS_JSON_SCHEMA,
      },
      options,
    );
    if (!result.ok) {
      return {
        status: "needs_review",
        reason: result.reason,
        detail: result.detail,
        provider: this.name,
        model: this.model,
        ...modelInfo(result),
      };
    }
    const validation = validateTermBoundsExtraction(result.parsed, excerpts, this.threshold);
    if (!validation.ok) {
      return {
        status: "needs_review",
        reason: validation.reason,
        detail: validation.detail,
        provider: this.name,
        model: this.model,
        ...modelInfo(result),
      };
    }
    return {
      status: "extracted",
      termStart: validation.termStart,
      termEnd: validation.termEnd,
      confidence: validation.confidence,
      provider: this.name,
      model: this.model,
      ...modelInfo(result),
      latencyMs: result.latencyMs,
    };
  }
}
