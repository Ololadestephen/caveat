import { isRecord, keySetError } from "../shape.ts";
import { normalizeWhitespace, parseMonthDayYear } from "../text.ts";
import { callStructuredChat, chatConfig, modelInfo } from "./chat.ts";
import { excerptTags, DECISION_SYSTEM_PROMPT } from "./prompt.ts";
import { quoteInText } from "./validate.ts";
import type { Excerpt, NeedsReviewOutcome, NeedsReviewReason } from "./types.ts";
import type { OpenRouterProviderConfig } from "./openrouter.ts";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;

export const SCHEDULE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["monthly_amount", "period", "releases", "confidence"],
  properties: {
    monthly_amount: {
      type: "object",
      additionalProperties: false,
      required: ["text", "excerpt_id", "quote"],
      properties: {
        text: { type: "string" },
        excerpt_id: { type: "string" },
        quote: { type: "string" },
      },
    },
    period: {
      type: "object",
      additionalProperties: false,
      required: ["text", "excerpt_id", "quote"],
      properties: {
        text: { type: "string" },
        excerpt_id: { type: "string" },
        quote: { type: "string" },
      },
    },
    releases: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["amount_text", "date_text", "condition_text", "excerpt_id", "quote"],
        properties: {
          amount_text: { type: "string" },
          date_text: { type: "string" },
          condition_text: { type: ["string", "null"] },
          excerpt_id: { type: "string" },
          quote: { type: "string" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const SCHEDULE_USER_PROMPT = `Extract the escrow payment schedule exactly as written. monthly_amount.text: the per-month compensation amount exactly as written (for example "$1,234"). period.text: the length of the escrow-funded period exactly as written (for example "3-month"). releases: every scheduled payment to the consultant out of escrow; amount_text and date_text exactly as written; condition_text: the condition clause exactly as written, or null if the payment is unconditional. Every text value must be copied verbatim from its quote, and every quote verbatim from one supplied excerpt. Do not add, total, or convert amounts or dates.`;

export type ValidatedRelease = {
  id: string;
  conditional: boolean;
  extensionId: string | undefined;
  amountText: string;
  amountCents: number;
  dateText: string;
  date: string;
  conditionText: string | null;
  excerptId: string;
  quote: string;
};

export type ValidatedSchedule = {
  monthlyAmountText: string;
  monthlyAmountCents: number;
  monthlyExcerptId: string;
  monthlyQuote: string;
  periodText: string;
  periodMonths: number;
  periodExcerptId: string;
  periodQuote: string;
  releases: ValidatedRelease[];
  confidence: number;
};

export type ScheduleValidation =
  | { ok: true; schedule: ValidatedSchedule }
  | { ok: false; reason: NeedsReviewReason; detail: string };

export type ScheduleOutcome =
  | {
      status: "extracted";
      schedule: ValidatedSchedule;
      provider: string;
      model: string;
      modelVersion?: string;
      servedBy?: string;
      latencyMs: number;
    }
  | NeedsReviewOutcome;

const AMOUNT_RE = /^\$(\d{1,3}(?:,\d{3})*)(\.\d{2})?$/;
const PERIOD_RE = /^(\d+)-month$/;
const UNTIL_DATE_RE = /until\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/;

export function parseAmountCents(text: string): number | undefined {
  const match = AMOUNT_RE.exec(text.trim());
  if (match === null) return undefined;
  const dollars = Number((match[1] ?? "").replaceAll(",", ""));
  const cents = match[2] !== undefined ? Number(match[2].slice(1)) : 0;
  return dollars * 100 + cents;
}

const AMOUNT_SEARCH_RE = /\$(\d{1,3}(?:,\d{3})*)(\.\d{2})?/;

// Extracts the first dollar amount inside a longer text ("$6,000 per month").
export function extractAmountCents(text: string): number | undefined {
  const match = AMOUNT_SEARCH_RE.exec(text);
  if (match === null) return undefined;
  const dollars = Number((match[1] ?? "").replaceAll(",", ""));
  const cents = match[2] !== undefined ? Number(match[2].slice(1)) : 0;
  return dollars * 100 + cents;
}

type Invalid = Extract<ScheduleValidation, { ok: false }>;

function fail(reason: NeedsReviewReason, detail: string): Invalid {
  return { ok: false, reason, detail };
}

type TextQuote = { text: string; excerpt_id: string; quote: string };

function checkTextQuote(
  field: TextQuote,
  fieldPath: string,
  excerptById: Map<string, { index: number; text: string }>,
): Invalid | undefined {
  if (typeof field.text !== "string" || field.text.length === 0) {
    return fail("schema_mismatch", `${fieldPath}.text must be a non-empty string`);
  }
  if (typeof field.excerpt_id !== "string" || field.excerpt_id.length === 0) {
    return fail("schema_mismatch", `${fieldPath}.excerpt_id must be a non-empty string`);
  }
  if (typeof field.quote !== "string" || field.quote.length === 0) {
    return fail("schema_mismatch", `${fieldPath}.quote must be a non-empty string`);
  }
  const excerpt = excerptById.get(field.excerpt_id);
  if (excerpt === undefined) {
    return fail(
      "unknown_excerpt",
      `${fieldPath} cites excerpt id ${JSON.stringify(field.excerpt_id)} which was not supplied`,
    );
  }
  if (!quoteInText(field.quote, excerpt.text)) {
    return fail("quote_not_verbatim", `${fieldPath}.quote is not verbatim in its cited excerpt`);
  }
  if (!quoteInText(field.text, field.quote)) {
    return fail("quote_not_verbatim", `${fieldPath}.text is not verbatim within its quote`);
  }
  return undefined;
}

type ExcerptIndex = Map<string, { index: number; text: string }>;

// One {text, excerpt_id, quote} field: shape first, then the verbatim chain.
function fieldQuote(
  parent: Record<string, unknown>,
  name: string,
  excerptById: ExcerptIndex,
): { ok: true; value: TextQuote } | Invalid {
  const field = parent[name];
  if (!isRecord(field)) return fail("schema_mismatch", `${name} is not a JSON object`);
  const keys = keySetError(field, ["text", "excerpt_id", "quote"]);
  if (keys !== undefined) return fail("schema_mismatch", `${name}: ${keys}`);
  const quote = field as unknown as TextQuote;
  const bad = checkTextQuote(quote, name, excerptById);
  if (bad !== undefined) return bad;
  return { ok: true, value: quote };
}

type RawRelease = {
  amount_text: string;
  date_text: string;
  condition_text: string | null;
  excerpt_id: string;
  quote: string;
};

// Shape and verbatim checks for the releases array, in model order.
function rawReleases(
  value: unknown,
  excerptById: ExcerptIndex,
): { ok: true; value: RawRelease[] } | Invalid {
  if (!Array.isArray(value)) {
    return fail("schema_mismatch", "releases is not an array");
  }
  if (value.length < 1 || value.length > 8) {
    return fail("schema_mismatch", "releases must contain between 1 and 8 items");
  }
  const RELEASE_KEYS = ["amount_text", "date_text", "condition_text", "excerpt_id", "quote"];
  const releases: RawRelease[] = [];
  for (const [i, item] of value.entries()) {
    const path = `releases[${i}]`;
    if (!isRecord(item)) return fail("schema_mismatch", `${path} is not a JSON object`);
    const keys = keySetError(item, RELEASE_KEYS);
    if (keys !== undefined) return fail("schema_mismatch", `${path}: ${keys}`);
    const release = item as unknown as RawRelease;
    const bad = checkTextQuote(
      { text: release.amount_text, excerpt_id: release.excerpt_id, quote: release.quote },
      `${path}.amount_text`,
      excerptById,
    );
    if (bad !== undefined) return bad;
    for (const [field, fieldValue] of [
      ["date_text", release.date_text],
      ["condition_text", release.condition_text],
    ] as const) {
      if (fieldValue === null) continue;
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        return fail("schema_mismatch", `${path}.${field} must be a string or null`);
      }
      if (!quoteInText(fieldValue, release.quote)) {
        return fail(
          "quote_not_verbatim",
          `${path}.${field} is not verbatim within its quote`,
        );
      }
    }
    releases.push(release);
  }
  return { ok: true, value: releases };
}

type PositionedRelease = {
  release: RawRelease;
  index: number;
  excerptIndex: number;
  quotePos: number;
};

// Build one ValidatedRelease from a raw release + its assigned id.
function buildRelease(
  release: RawRelease,
  id: string,
  conditional: boolean,
): { ok: true; value: ValidatedRelease } | Invalid {
  const amountCents = parseAmountCents(release.amount_text);
  if (amountCents === undefined) {
    return fail(
      "schema_mismatch",
      `release amount_text ${JSON.stringify(release.amount_text)} is not a dollar amount like "$1,234"`,
    );
  }
  const parsedDate = parseMonthDayYear(release.date_text);
  if (parsedDate === undefined) {
    return fail(
      "schema_mismatch",
      `release date_text ${JSON.stringify(release.date_text)} is not a "Month D, YYYY" date`,
    );
  }
  let extensionId: string | undefined;
  if (conditional) {
    const until = UNTIL_DATE_RE.exec(release.condition_text ?? "");
    const untilDate = until !== null ? parseMonthDayYear(until[1] ?? "") : undefined;
    if (untilDate === undefined) {
      return fail(
        "schema_mismatch",
        `release condition_text ${JSON.stringify(release.condition_text)} contains no "until <Month D, YYYY>" date`,
      );
    }
    extensionId = `ext-${untilDate.iso}`;
  }
  return {
    ok: true,
    value: {
      id,
      conditional,
      extensionId,
      amountText: release.amount_text,
      amountCents,
      dateText: release.date_text,
      date: parsedDate.iso,
      conditionText: release.condition_text,
      excerptId: release.excerpt_id,
      quote: release.quote,
    },
  };
}

// Validates one parsed schedule extraction: schema shape first, then the
// verbatim chain (each text inside its quote, each quote inside its cited
// excerpt, whitespace-normalised), then the field formats, confidence, and
// finally the internal-consistency check. Release ids are assigned here from
// document position, never from the model's array order.
export function validateScheduleExtraction(
  parsed: unknown,
  excerpts: Excerpt[],
  threshold: number,
): ScheduleValidation {
  if (!isRecord(parsed)) {
    return fail("schema_mismatch", "extraction is not a JSON object");
  }
  const topError = keySetError(parsed, ["monthly_amount", "period", "releases", "confidence"]);
  if (topError !== undefined) return fail("schema_mismatch", topError);

  const excerptById = new Map(excerpts.map((e, index) => [e.id, { index, text: e.text }]));

  const monthlyOut = fieldQuote(parsed, "monthly_amount", excerptById);
  if (!monthlyOut.ok) return monthlyOut;
  const monthly = monthlyOut.value;

  const periodOut = fieldQuote(parsed, "period", excerptById);
  if (!periodOut.ok) return periodOut;
  const period = periodOut.value;

  const releasesOut = rawReleases(parsed.releases, excerptById);
  if (!releasesOut.ok) return releasesOut;

  const confidence = parsed.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return fail("schema_mismatch", "confidence must be a number between 0 and 1");
  }

  const monthlyAmountCents = parseAmountCents(monthly.text);
  if (monthlyAmountCents === undefined) {
    return fail(
      "schema_mismatch",
      `monthly_amount.text ${JSON.stringify(monthly.text)} is not a dollar amount like "$1,234"`,
    );
  }
  const periodMatch = PERIOD_RE.exec(period.text.trim());
  if (periodMatch === null) {
    return fail(
      "schema_mismatch",
      `period.text ${JSON.stringify(period.text)} is not a "<n>-month" period`,
    );
  }
  const periodMonths = Number(periodMatch[1]);

  // Number the releases by document position, separately per conditionality.
  const positioned: PositionedRelease[] = releasesOut.value.map((release, index) => {
    const excerpt = excerptById.get(release.excerpt_id);
    const quotePos =
      excerpt === undefined
        ? -1
        : normalizeWhitespace(excerpt.text).indexOf(normalizeWhitespace(release.quote));
    return { release, index, excerptIndex: excerpt?.index ?? -1, quotePos };
  });
  positioned.sort((a, b) => a.excerptIndex - b.excerptIndex || a.quotePos - b.quotePos || a.index - b.index);
  const unconditional = positioned.filter((p) => p.release.condition_text === null);
  const conditional = positioned.filter((p) => p.release.condition_text !== null);

  const releases: ValidatedRelease[] = [];
  let releaseSum = 0;
  const buildAll = (
    entries: PositionedRelease[],
    idPrefix: string,
    conditionalReleases: boolean,
  ): ScheduleValidation | undefined => {
    for (const [i, entry] of entries.entries()) {
      const built = buildRelease(entry.release, `${idPrefix}${i + 1}`, conditionalReleases);
      if (!built.ok) return built;
      releases.push(built.value);
      releaseSum += built.value.amountCents;
    }
    return undefined;
  };
  const unconditionalBad = buildAll(unconditional, "release-", false);
  if (unconditionalBad !== undefined) return unconditionalBad;
  const conditionalBad = buildAll(conditional, "release-ext-", true);
  if (conditionalBad !== undefined) return conditionalBad;

  if (confidence < threshold) {
    return fail(
      "low_confidence",
      `self-reported confidence ${confidence} is below threshold ${threshold}`,
    );
  }

  const expected = monthlyAmountCents * periodMonths;
  if (expected !== releaseSum) {
    return fail(
      "inconsistent_terms",
      `monthly amount ${monthlyAmountCents} x ${periodMonths} months = ${expected} but the releases sum to ${releaseSum}`,
    );
  }

  return {
    ok: true,
    schedule: {
      monthlyAmountText: monthly.text,
      monthlyAmountCents,
      monthlyExcerptId: monthly.excerpt_id,
      monthlyQuote: monthly.quote,
      periodText: period.text,
      periodMonths,
      periodExcerptId: period.excerpt_id,
      periodQuote: period.quote,
      releases,
      confidence,
    },
  };
}

export class OpenRouterScheduleExtractor {
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
  ): Promise<ScheduleOutcome> {
    const userPrompt = `${SCHEDULE_USER_PROMPT}\n\n${excerptTags(question.excerpts)}`;
    const result = await callStructuredChat(
      chatConfig(this.gatewayBaseUrl, this.timeoutMs, this.allowedModelVersions, this.fetchImpl),
      {
        model: this.model,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        userPrompt,
        schemaName: "schedule_extraction",
        schema: SCHEDULE_JSON_SCHEMA,
      },
      options,
    );

    const failOutcome = (
      reason: NeedsReviewReason,
      detail: string,
      extra?: { modelVersion?: string; servedBy?: string },
    ): ScheduleOutcome => ({
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
    const validation = validateScheduleExtraction(result.parsed, question.excerpts, this.threshold);
    if (!validation.ok) {
      return failOutcome(validation.reason, validation.detail, modelInfo(result));
    }
    return {
      status: "extracted",
      schedule: validation.schedule,
      provider: this.name,
      model: this.model,
      ...modelInfo(result),
      latencyMs: result.latencyMs,
    };
  }
}
