import { isRecord, keySetError } from "../shape.ts";
import { parseMonthDayYear } from "../text.ts";
import { callStructuredChat, chatConfig, modelInfo } from "./chat.ts";
import { excerptTags, DECISION_SYSTEM_PROMPT } from "./prompt.ts";
import { quoteInText } from "./validate.ts";
import { parseAmountCents } from "./schedule.ts";
import type { Excerpt } from "./types.ts";
import type { Lever, ProposedCandidate } from "../search/levers.ts";
import type { OpenRouterProviderConfig } from "./openrouter.ts";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;

const LEVERS: readonly Lever[] = [
  "upfront_deposit",
  "earlier_release",
  "milestone_split",
  "shorter_payment_terms",
];

export const CLIENT_COUNTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "readable",
    "lever",
    "amount_text",
    "date_text",
    "split_count_text",
    "net_days_text",
    "excerpt_id",
    "quote",
    "unclear_note",
    "confidence",
  ],
  properties: {
    readable: { type: "boolean" },
    lever: {
      type: ["string", "null"],
      enum: [...LEVERS],
    },
    amount_text: { type: ["string", "null"] },
    date_text: { type: ["string", "null"] },
    split_count_text: { type: ["string", "null"] },
    net_days_text: { type: ["string", "null"] },
    excerpt_id: { type: ["string", "null"] },
    quote: { type: ["string", "null"] },
    unclear_note: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const CLIENT_COUNTER_USER_PROMPT = `Read the client's reply letter and extract the one payment-term change the client proposes, exactly as written. lever: which of these the change is: upfront_deposit (part of the escrow funding paid to the consultant at funding instead of into escrow), earlier_release (part of the first unconditional escrow release paid on an earlier date), milestone_split (part of the first unconditional release paid in 2 or 3 monthly parts before it), shorter_payment_terms (each covered month's fees released a stated number of days after the month ends). amount_text, date_text, split_count_text and net_days_text: copied verbatim from quote, or null when the lever does not use that field (upfront_deposit and earlier_release use amount_text and date_text; milestone_split uses amount_text, date_text for the first part, and split_count_text; shorter_payment_terms uses net_days_text only). quote: the sentence stating the proposal, verbatim from one supplied excerpt; excerpt_id: that excerpt's id. Set readable to false and lever to null when the letter proposes no change, more than one change, a change outside these four levers, or anything you cannot read with certainty, and explain why in unclear_note. Do not add, total, or convert amounts or dates.`;

export type ClientCitation = { excerptId: string; quote: string; page: number | undefined };

export type ClientCounterOutcome =
  | {
      status: "extracted";
      candidate: ProposedCandidate;
      citation: ClientCitation;
      provider: string;
      model: string;
      modelVersion?: string;
      servedBy?: string;
      latencyMs: number;
      carriedFrom?: string;
    }
  | {
      status: "needs_review";
      reason: string;
      detail: string;
      provider: string;
      model?: string;
      modelVersion?: string;
      servedBy?: string;
    };

type Invalid = { ok: false; reason: string; detail: string };
type Valid = { ok: true; candidate: ProposedCandidate; citation: ClientCitation };

function invalid(reason: string, detail: string): Invalid {
  return { ok: false, reason, detail };
}

// Which copied-text fields each lever uses — the same required/allowed split
// FIELD_SPECS applies to the compiled params, one level up on the raw text.
const TEXT_FIELD_SPECS: Record<Lever, { required: string[]; allowed: string[] }> = {
  upfront_deposit: { required: ["amount_text", "date_text"], allowed: ["amount_text", "date_text"] },
  earlier_release: { required: ["amount_text", "date_text"], allowed: ["amount_text", "date_text"] },
  milestone_split: {
    required: ["amount_text", "date_text", "split_count_text"],
    allowed: ["amount_text", "date_text", "split_count_text"],
  },
  shorter_payment_terms: { required: ["net_days_text"], allowed: ["net_days_text"] },
};

const TEXT_FIELDS = ["amount_text", "date_text", "split_count_text", "net_days_text"] as const;

type RawCounter = {
  readable: unknown;
  lever: unknown;
  amount_text: unknown;
  date_text: unknown;
  split_count_text: unknown;
  net_days_text: unknown;
  excerpt_id: unknown;
  quote: unknown;
  unclear_note: unknown;
  confidence: unknown;
};

// "2" | "3" | "two" | "three", case-insensitive.
function parseSplitCount(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (t === "2" || t === "two") return 2;
  if (t === "3" || t === "three") return 3;
  return undefined;
}

// "N" or "N days", 1..90.
function parseNetDays(text: string): number | undefined {
  const match = /^(\d{1,2})(?:\s*days?)?$/i.exec(text.trim());
  if (match === null) return undefined;
  const days = Number(match[1]);
  return days >= 1 && days <= 90 ? days : undefined;
}

// The code-side half of the client reply read: shape, the unreadable exit,
// the verbatim chain, the field set for the lever, the field formats, and the
// confidence gate — in that order, each failure a named reason.
export function validateClientCounter(
  parsed: unknown,
  excerpts: Excerpt[],
  threshold: number,
): Valid | Invalid {
  if (!isRecord(parsed)) {
    return invalid("schema_mismatch", "client counter is not a JSON object");
  }
  const topError = keySetError(parsed, [
    "readable",
    "lever",
    "amount_text",
    "date_text",
    "split_count_text",
    "net_days_text",
    "excerpt_id",
    "quote",
    "unclear_note",
    "confidence",
  ]);
  if (topError !== undefined) return invalid("schema_mismatch", topError);
  const raw = parsed as unknown as RawCounter;

  const readableError = checkReadable(raw);
  if (readableError !== undefined) return readableError;
  const lever = raw.lever as Lever;

  const chain = checkVerbatimChain(raw, excerpts);
  if ("reason" in chain) return chain;
  const { excerpt } = chain;

  const spec = TEXT_FIELD_SPECS[lever];
  const fieldError = checkFieldSpec(raw, lever, spec);
  if (fieldError !== undefined) return fieldError;

  const parsed_ = parseCounterFields(raw, lever, spec);
  if ("reason" in parsed_) return parsed_;
  const { candidate } = parsed_;

  const confidenceError = checkConfidence(raw, threshold);
  if (confidenceError !== undefined) return confidenceError;

  return {
    ok: true,
    candidate,
    citation: { excerptId: raw.excerpt_id as string, quote: raw.quote as string, page: excerpt.page },
  };
}

// The unreadable exit and the lever check — in that order.
function checkReadable(raw: RawCounter): Invalid | undefined {
  if (raw.readable === false) {
    return invalid(
      "counter_unreadable",
      typeof raw.unclear_note === "string" && raw.unclear_note.length > 0
        ? raw.unclear_note
        : "the model could not read a single proposed change from the letter",
    );
  }
  if (raw.readable !== true) {
    return invalid("schema_mismatch", "readable must be a boolean");
  }
  if (typeof raw.lever !== "string" || !LEVERS.includes(raw.lever as Lever)) {
    return invalid("schema_mismatch", "lever must be one of the four levers when readable");
  }
  return undefined;
}

// The verbatim chain: excerpt_id names a supplied excerpt, quote is verbatim
// in it, and every non-null text field is verbatim within the quote.
function checkVerbatimChain(
  raw: RawCounter,
  excerpts: Excerpt[],
): Invalid | { excerpt: { index: number; text: string; page: number } } {
  const excerptById = new Map(excerpts.map((e, index) => [e.id, { index, text: e.text, page: e.source.page }]));
  if (typeof raw.excerpt_id !== "string" || raw.excerpt_id.length === 0) {
    return invalid("schema_mismatch", "excerpt_id must be a non-empty string");
  }
  const excerpt = excerptById.get(raw.excerpt_id);
  if (excerpt === undefined) {
    return invalid(
      "unknown_excerpt",
      `excerpt_id cites ${JSON.stringify(raw.excerpt_id)} which was not supplied`,
    );
  }
  if (typeof raw.quote !== "string" || raw.quote.length === 0) {
    return invalid("schema_mismatch", "quote must be a non-empty string");
  }
  if (!quoteInText(raw.quote, excerpt.text)) {
    return invalid("quote_not_verbatim", "quote is not verbatim in its cited excerpt");
  }
  for (const field of TEXT_FIELDS) {
    const value = raw[field];
    if (value === null) continue;
    if (typeof value !== "string" || value.length === 0) {
      return invalid("schema_mismatch", `${field} must be a string or null`);
    }
    if (!quoteInText(value, raw.quote)) {
      return invalid("quote_not_verbatim", `${field} is not verbatim within the quote`);
    }
  }
  return { excerpt };
}

// The field set for the lever: required fields non-null, disallowed fields null.
function checkFieldSpec(
  raw: RawCounter,
  lever: Lever,
  spec: (typeof TEXT_FIELD_SPECS)[Lever],
): Invalid | undefined {
  for (const field of spec.required) {
    if (raw[field as keyof RawCounter] === null) {
      return invalid("missing_field", `${lever} requires ${field}`);
    }
  }
  for (const field of TEXT_FIELDS) {
    if (!spec.allowed.includes(field) && raw[field] !== null) {
      return invalid("unexpected_field", `${lever} does not take ${field}`);
    }
  }
  return undefined;
}

// The field formats: each allowed text field parses to its typed value.
function parseCounterFields(
  raw: RawCounter,
  lever: Lever,
  spec: (typeof TEXT_FIELD_SPECS)[Lever],
): Invalid | { candidate: ProposedCandidate } {
  const candidate: ProposedCandidate = {
    lever,
    amount_cents: null,
    date: null,
    split_count: null,
    net_days: null,
    rationale: "client counter",
  };
  if (spec.allowed.includes("amount_text")) {
    const cents = parseAmountCents(raw.amount_text as string);
    if (cents === undefined) {
      return invalid(
        "parse_amount",
        `amount_text ${JSON.stringify(raw.amount_text)} is not a dollar amount like "$1,234"`,
      );
    }
    candidate.amount_cents = cents;
  }
  if (spec.allowed.includes("date_text")) {
    const parsedDate = parseMonthDayYear(raw.date_text as string);
    if (parsedDate === undefined) {
      return invalid(
        "parse_date",
        `date_text ${JSON.stringify(raw.date_text)} is not a "Month D, YYYY" date`,
      );
    }
    candidate.date = parsedDate.iso;
  }
  if (spec.allowed.includes("split_count_text")) {
    const count = parseSplitCount(raw.split_count_text as string);
    if (count === undefined) {
      return invalid(
        "parse_split_count",
        `split_count_text ${JSON.stringify(raw.split_count_text)} is not "2", "3", "two" or "three"`,
      );
    }
    candidate.split_count = count;
  }
  if (spec.allowed.includes("net_days_text")) {
    const days = parseNetDays(raw.net_days_text as string);
    if (days === undefined) {
      return invalid(
        "parse_net_days",
        `net_days_text ${JSON.stringify(raw.net_days_text)} is not "N" or "N days" with N between 1 and 90`,
      );
    }
    candidate.net_days = days;
  }
  return { candidate };
}

// The confidence gate: a number in [0,1] at or above the threshold.
function checkConfidence(raw: RawCounter, threshold: number): Invalid | undefined {
  const confidence = raw.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return invalid("schema_mismatch", "confidence must be a number between 0 and 1");
  }
  if (confidence < threshold) {
    return invalid(
      "low_confidence",
      `self-reported confidence ${confidence} is below threshold ${threshold}`,
    );
  }
  return undefined;
}

export class OpenRouterClientCounterExtractor {
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
  ): Promise<ClientCounterOutcome> {
    const userPrompt = `${CLIENT_COUNTER_USER_PROMPT}\n\n${excerptTags(question.excerpts)}`;
    const result = await callStructuredChat(
      chatConfig(this.gatewayBaseUrl, this.timeoutMs, this.allowedModelVersions, this.fetchImpl),
      {
        model: this.model,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        userPrompt,
        schemaName: "client_counter",
        schema: CLIENT_COUNTER_SCHEMA,
      },
      options,
    );

    const failOutcome = (
      reason: string,
      detail: string,
      extra?: { modelVersion?: string; servedBy?: string },
    ): ClientCounterOutcome => ({
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
    const validation = validateClientCounter(result.parsed, question.excerpts, this.threshold);
    if (!validation.ok) {
      return failOutcome(validation.reason, validation.detail, modelInfo(result));
    }
    return {
      status: "extracted",
      candidate: validation.candidate,
      citation: validation.citation,
      provider: this.name,
      model: this.model,
      ...modelInfo(result),
      latencyMs: result.latencyMs,
    };
  }
}
