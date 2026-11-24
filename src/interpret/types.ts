export type ExcerptSource = {
  fileName: string;
  versionLabel: string;
  page: number;
};

export type Excerpt = {
  id: string;
  text: string;
  source: ExcerptSource;
};

export type BillingTriggerQuestion = {
  questionId: string;
  excerpts: Excerpt[];
};

export const DECISION_ACTIONS = [
  "delivery_triggered",
  "acceptance_triggered",
  "ambiguous",
] as const;

export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export type Decision = {
  action: DecisionAction;
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
  | "model_mismatch"
  | "missing_model_version"
  | "blocked"
  | "truncated"
  | "rate_limited"
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
      latencyMs: number;
    }
  | {
      status: "needs_review";
      reason: NeedsReviewReason;
      detail: string;
      provider: string;
      model?: string;
      modelVersion?: string;
      decision?: Decision;
    };
