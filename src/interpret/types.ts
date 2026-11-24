export type ExcerptSource = {
  fileName: string;
  versionLabel: string;
  page: number;
  section?: string;
};

export type Excerpt = {
  id: string;
  text: string;
  source: ExcerptSource;
};

export type QuestionSpec = {
  id: string;
  questionText: string;
  actions: readonly string[];
};

export const BILLING_TRIGGER: QuestionSpec = {
  id: "billing_trigger",
  questionText:
    "does the contract text trigger billing on delivery, on client acceptance, or is it ambiguous?",
  actions: ["delivery_triggered", "acceptance_triggered", "ambiguous"],
};

export const RELEASE_TIMING: QuestionSpec = {
  id: "release_timing",
  questionText:
    "When does the consultant actually receive the cash compensation described in these excerpts? Choose cash_on_fixed_date if cash is paid directly to the consultant on stated calendar dates; escrow_release if the money is first paid into escrow and reaches the consultant only when released on stated dates; transaction_triggered if payment depends on a transaction event such as signing or closing a merger; ambiguous if the excerpts do not clearly support exactly one of these.",
  actions: ["cash_on_fixed_date", "escrow_release", "transaction_triggered", "ambiguous"],
};

export type Question = {
  spec: QuestionSpec;
  id: string;
  excerpts: Excerpt[];
};

export type Decision = {
  action: string;
  reason: string;
  cited_clause: { excerpt_id: string; quote: string };
  confidence: number;
};

export type NeedsReviewReason =
  | "ambiguous"
  | "low_confidence"
  | "schema_mismatch"
  | "malformed_json"
  | "unknown_excerpt"
  | "quote_not_verbatim"
  | "inconsistent_terms"
  | "model_mismatch"
  | "missing_model_version"
  | "blocked"
  | "truncated"
  | "rate_limited"
  | "provider_error"
  | "http_error"
  | "timeout"
  | "network_error";

export type DecisionOutcome =
  | {
      status: "decided";
      decision: Decision;
      provider: string;
      model: string;
      modelVersion?: string;
      servedBy?: string;
      latencyMs: number;
    }
  | {
      status: "needs_review";
      reason: NeedsReviewReason;
      detail: string;
      provider: string;
      model?: string;
      modelVersion?: string;
      servedBy?: string;
      decision?: Decision;
    };
