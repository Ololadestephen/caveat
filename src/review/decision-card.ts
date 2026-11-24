import type {
  BillingTriggerQuestion,
  DecisionAction,
  DecisionOutcome,
  Excerpt,
  NeedsReviewReason,
} from "../interpret/types.ts";

const ACTION_LABELS: Record<DecisionAction, string> = {
  delivery_triggered: "Delivery triggered",
  acceptance_triggered: "Acceptance triggered",
  ambiguous: "Ambiguous",
};

const REVIEW_REASON_LABELS: Record<NeedsReviewReason, string> = {
  ambiguous: "Provider reported the terms as ambiguous",
  low_confidence: "Self-reported confidence below threshold",
  schema_mismatch: "Provider output failed schema validation",
  malformed_json: "Provider output was not valid JSON",
  unknown_excerpt: "Cited excerpt was not among the supplied excerpts",
  quote_not_verbatim: "Cited quote is not verbatim in the supplied excerpt",
  model_mismatch: "Response model did not match the pinned model",
  http_error: "Provider returned an HTTP error",
  timeout: "Provider request timed out",
  network_error: "Provider request failed at the network layer",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatConfidence(confidence: number): string {
  return `self-reported confidence ${confidence.toFixed(2)}`;
}

function findExcerpt(
  question: BillingTriggerQuestion | undefined,
  excerptId: string,
): Excerpt | undefined {
  return question?.excerpts.find((e) => e.id === excerptId);
}

function excerptSourceLine(excerpt: Excerpt | undefined, excerptId: string): string {
  if (excerpt === undefined) {
    return `excerpt ${escapeHtml(excerptId)}`;
  }
  const { fileName, versionLabel, page } = excerpt.source;
  return `excerpt ${escapeHtml(excerptId)} — ${escapeHtml(fileName)}, ${escapeHtml(versionLabel)}, page ${page}`;
}

function modelLine(model: string | undefined): string {
  return model === undefined ? "" : `<p class="decision-model">model ${escapeHtml(model)}</p>`;
}

export function renderDecisionCard(
  outcome: DecisionOutcome,
  question?: BillingTriggerQuestion,
): string {
  if (outcome.status === "decided") {
    const { decision } = outcome;
    const excerpt = findExcerpt(question, decision.cited_clause.excerpt_id);
    return `<section class="decision-card decision-card--decided" data-provider="${escapeHtml(outcome.provider)}">
  <h2 class="decision-heading">Billing trigger decision</h2>
  <p class="decision-action">${escapeHtml(ACTION_LABELS[decision.action])}</p>
  <p class="decision-reason">${escapeHtml(decision.reason)}</p>
  <blockquote class="decision-quote">
    <p>&ldquo;${escapeHtml(decision.cited_clause.quote)}&rdquo;</p>
    <cite>${excerptSourceLine(excerpt, decision.cited_clause.excerpt_id)}</cite>
  </blockquote>
  ${modelLine(outcome.model)}
  <p class="decision-confidence">${formatConfidence(decision.confidence)}</p>
</section>`;
  }

  const decisionBlock =
    outcome.decision === undefined
      ? ""
      : `
  <p class="decision-action">${escapeHtml(ACTION_LABELS[outcome.decision.action])}</p>
  <p class="decision-reason">${escapeHtml(outcome.decision.reason)}</p>
  <blockquote class="decision-quote">
    <p>&ldquo;${escapeHtml(outcome.decision.cited_clause.quote)}&rdquo;</p>
    <cite>${excerptSourceLine(findExcerpt(question, outcome.decision.cited_clause.excerpt_id), outcome.decision.cited_clause.excerpt_id)}</cite>
  </blockquote>
  <p class="decision-confidence">${formatConfidence(outcome.decision.confidence)}</p>`;

  return `<section class="decision-card decision-card--needs-review" data-provider="${escapeHtml(outcome.provider)}">
  <h2 class="decision-heading">Needs human review</h2>
  <p class="decision-review-reason">${escapeHtml(REVIEW_REASON_LABELS[outcome.reason])}</p>
  <p class="decision-review-detail">${escapeHtml(outcome.detail)}</p>
  ${modelLine(outcome.model)}
  ${decisionBlock}
</section>`;
}
