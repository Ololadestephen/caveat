import type { EvidenceFlag } from "../evidence/flags.ts";
import type { ScheduleOutcome } from "../interpret/schedule.ts";
import type { DecisionOutcome, Excerpt, Question } from "../interpret/types.ts";
import type { PolicyAdjustment, TwinveeAssumptions } from "../plan/twinvee.ts";
import type { ScenarioResult } from "../runner/types.ts";
import type { CounterofferReceipt } from "../search/loop.ts";
import type { RetainerReview, SourcedOverride } from "./human-review.ts";

export const RECEIPT_VERSION = "caveat-receipt/2";

export type ReceiptSource = {
  fileName: string;
  versionLabel: string;
  versionPresent: boolean;
  edgarUrl: string | null;
};

// One modeled reading of the contract (e.g. retainer superseded vs continues).
export type ReceiptReading = {
  id: string;
  label: string;
  inputDigest: string;
  resultDigest: string;
  smallestPassingCandidate: string | null;
  results: Record<string, Record<string, ScenarioResult>>;
  adjustments: { scenarioId: string; adjustments: PolicyAdjustment[] }[];
};

export type ReceiptBlockedReason = { reason: string; detail: string };

export type HumanReviewReceipt =
  | { status: "ok"; review: RetainerReview }
  | { status: "needs_review"; reason: "review_citation_invalid"; detail: string };

// The canonical record of a coordinator run. Contains no Box ids, URLs or raw
// provider bodies — only validated outputs, digests and citations.
export type RunReceipt = {
  // Stored receipts keep the version they were written under; the pipeline
  // always stamps RECEIPT_VERSION on new ones.
  receiptVersion: string;
  runId: string;
  status: "reviewable" | "needs_review";
  blockedReasons: ReceiptBlockedReason[];
  questionIds: string[];
  sources: ReceiptSource[];
  releaseTiming: { outcome: DecisionOutcome; question: Question } | null;
  // The action used downstream: the decided action, or a validated human
  // override answer when the model's outcome needed review.
  effectiveAction: string | null;
  overrides: SourcedOverride[];
  schedule: { outcome: ScheduleOutcome; excerpts: Excerpt[] } | null;
  humanReview: HumanReviewReceipt;
  flags: EvidenceFlag[];
  readings: ReceiptReading[];
  assumptions: TwinveeAssumptions;
  // Added in v2 — absent on v1 receipts and on runs where the search never ran.
  counteroffer?: CounterofferReceipt;
};
