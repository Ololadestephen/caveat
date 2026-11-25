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
// What differs between a run and the previous run it was based on. Present
// whenever the pipeline was given a previous run — even when nothing could be
// carried forward.
export type IncrementalInfo = {
  previousRunId: string;
  // "incremental" = the previous receipt had digests to compare against;
  // "full_no_baseline" = it did not, so every typed call reran.
  mode: "incremental" | "full_no_baseline";
  changedFiles: {
    fileName: string;
    fromVersionTag: string | null;
    toVersionTag: string | null;
    contentChanged: boolean;
  }[];
  changedSections: { added: string[]; removed: string[]; changed: string[] };
  totalSections: number;
  // Which typed model calls ran fresh vs were carried forward.
  reran: string[];
  carriedForward: string[];
};

export type RunReceipt = {
  // Stored receipts keep the version they were written under; the pipeline
  // always stamps RECEIPT_VERSION on new ones.
  receiptVersion: string;
  runId: string;
  // "manual" | "watcher" — absent on receipts written before the watcher.
  trigger?: "manual" | "watcher";
  status: "reviewable" | "needs_review";
  blockedReasons: ReceiptBlockedReason[];
  questionIds: string[];
  sources: ReceiptSource[];
  // sha256 of every section's text, keyed by excerpt id ("file#section").
  // Lets a later run diff Box changes at clause granularity.
  sectionDigests?: Record<string, string>;
  // Digest of exactly what determines each typed model call; a matching digest
  // means the call's inputs are identical and its outcome can be reused.
  typedCallDigests?: {
    release_timing: string;
    escrow_schedule: string;
    counteroffer_search: string;
  };
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
  incremental?: IncrementalInfo;
};
