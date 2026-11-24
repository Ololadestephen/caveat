import { describe, expect, it } from "vitest";
import { escapeHtml, renderDecisionCard } from "./decision-card.ts";
import type { BillingTriggerQuestion, DecisionOutcome } from "../interpret/types.ts";

const QUESTION: BillingTriggerQuestion = {
  questionId: "q-billing",
  excerpts: [
    {
      id: "ex-1",
      text: "Payment of the milestone fee is due upon the Client's written acceptance of the Deliverables.",
      source: { fileName: "sow.pdf", versionLabel: "v1", page: 3 },
    },
  ],
};

const DECIDED: DecisionOutcome = {
  status: "decided",
  decision: {
    action: "acceptance_triggered",
    reason: "Payment is due on written acceptance.",
    cited_clause: { excerpt_id: "ex-1", quote: "due upon the Client's written acceptance" },
    confidence: 0.92,
  },
  provider: "gemini",
  model: "gemini-flash-latest",
  modelVersion: "gemini-3-flash",
  latencyMs: 812,
};

describe("renderDecisionCard", () => {
  it("renders the typed decision with citation, model and self-reported confidence", () => {
    const html = renderDecisionCard(DECIDED, QUESTION);
    expect(html).toContain("Acceptance triggered");
    expect(html).toContain("Payment is due on written acceptance.");
    expect(html).toContain("due upon the Client&#39;s written acceptance");
    expect(html).toContain("sow.pdf");
    expect(html).toContain("v1");
    expect(html).toContain("page 3");
    expect(html).toContain("model gemini-flash-latest &rarr; gemini-3-flash");
    expect(html).toContain("self-reported confidence 0.92");
    expect(html).toContain('data-provider="gemini"');
  });

  it("labels the confidence as self-reported, never as accuracy or probability", () => {
    const html = renderDecisionCard(DECIDED, QUESTION);
    expect(html).not.toMatch(/accuracy|probabilit/i);
    expect(html).toContain("self-reported confidence");
  });

  it("escapes hostile model output", () => {
    const hostile: DecisionOutcome = {
      ...DECIDED,
      decision: {
        action: "delivery_triggered",
        reason: '"><script>alert("xss")</script>',
        cited_clause: {
          excerpt_id: "ex-1",
          quote: '<img src=x onerror="alert(1)">',
        },
        confidence: 0.5,
      },
      model: 'evil"><svg>',
    };
    const html = renderDecisionCard(hostile, QUESTION);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
    expect(escapeHtml('<a href="x">&\'')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("renders the needs_review state with reason and detail", () => {
    const review: DecisionOutcome = {
      status: "needs_review",
      reason: "low_confidence",
      detail: "self-reported confidence 0.60 is below threshold 0.8",
      provider: "gemini",
      model: "gemini-flash-latest",
      modelVersion: "gemini-3-flash",
      decision: {
        action: "acceptance_triggered",
        reason: "Unsure which clause applies.",
        cited_clause: { excerpt_id: "ex-1", quote: "milestone fee" },
        confidence: 0.6,
      },
    };
    const html = renderDecisionCard(review, QUESTION);
    expect(html).toContain("Needs human review");
    expect(html).toContain("Self-reported confidence below threshold");
    expect(html).toContain("below threshold 0.8");
    expect(html).toContain("gemini-flash-latest");
    expect(html).toContain("gemini-3-flash");
    expect(html).toContain("Unsure which clause applies.");
  });

  it("renders needs_review without a decision and escapes the detail", () => {
    const review: DecisionOutcome = {
      status: "needs_review",
      reason: "malformed_json",
      detail: 'content was "<b>not json</b>"',
      provider: "ollama",
    };
    const html = renderDecisionCard(review);
    expect(html).toContain("Needs human review");
    expect(html).toContain("Provider output was not valid JSON");
    expect(html).toContain("&lt;b&gt;not json&lt;/b&gt;");
    expect(html).not.toContain("<b>not json</b>");
  });

  it("covers every needs_review reason label", () => {
    const reasons = [
      "ambiguous",
      "low_confidence",
      "schema_mismatch",
      "malformed_json",
      "unknown_excerpt",
      "quote_not_verbatim",
      "model_mismatch",
      "missing_model_version",
      "blocked",
      "truncated",
      "rate_limited",
      "http_error",
      "timeout",
      "network_error",
    ] as const;
    for (const reason of reasons) {
      const html = renderDecisionCard({
        status: "needs_review",
        reason,
        detail: `detail for ${reason}`,
        provider: "gemini",
      });
      expect(html).toContain("Needs human review");
      expect(html).toContain(`detail for ${reason}`);
    }
  });

  it("falls back to the excerpt id when no question is provided", () => {
    const html = renderDecisionCard(DECIDED);
    expect(html).toContain("excerpt ex-1");
    expect(html).not.toContain("sow.pdf");
  });
});
