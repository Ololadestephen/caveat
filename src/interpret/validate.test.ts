import { describe, expect, it } from "vitest";
import { validateDecision } from "./validate.ts";
import type { BillingTriggerQuestion } from "./types.ts";

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

const VALID = {
  action: "acceptance_triggered",
  reason: "Payment is due on written acceptance.",
  cited_clause: { excerpt_id: "ex-1", quote: "due upon the Client's written acceptance" },
  confidence: 0.95,
};

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

describe("validateDecision", () => {
  it("accepts a valid decision", () => {
    const result = validateDecision(decision(), QUESTION, 0.8);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision).toEqual(VALID);
  });

  it.each([
    ["extra top-level key", decision({ extra: 1 })],
    ["missing required key", { action: VALID.action, cited_clause: VALID.cited_clause, confidence: 0.9 }],
    ["extra cited_clause key", decision({ cited_clause: { ...VALID.cited_clause, note: "x" } })],
    ["wrong action enum", decision({ action: "maybe" })],
    ["wrong confidence type", decision({ confidence: "high" })],
    ["confidence out of range", decision({ confidence: 1.5 })],
    ["reason over 500 chars", decision({ reason: "x".repeat(501) })],
    ["quote over 600 chars", decision({ cited_clause: { excerpt_id: "ex-1", quote: "x".repeat(601) } })],
    ["decision not an object", [1, 2, 3]],
  ])("routes %s to schema_mismatch", (_label, parsed) => {
    const result = validateDecision(parsed, QUESTION, 0.8);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema_mismatch");
  });

  it("routes an unknown excerpt id to unknown_excerpt", () => {
    const result = validateDecision(
      decision({ cited_clause: { excerpt_id: "ex-9", quote: "anything" } }),
      QUESTION,
      0.8,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_excerpt");
  });

  it.each([
    ["quote not in excerpt", "not in the excerpt"],
    ["empty quote", ""],
  ])("routes %s to quote_not_verbatim", (_label, quote) => {
    const result = validateDecision(
      decision({ cited_clause: { excerpt_id: "ex-1", quote } }),
      QUESTION,
      0.8,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quote_not_verbatim");
  });

  it("routes the ambiguous action to ambiguous with the decision attached", () => {
    const result = validateDecision(decision({ action: "ambiguous" }), QUESTION, 0.8);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.decision?.action).toBe("ambiguous");
    }
  });

  it("routes confidence below the threshold to low_confidence", () => {
    const result = validateDecision(decision({ confidence: 0.79 }), QUESTION, 0.8);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("low_confidence");
  });

  it("accepts confidence exactly at the threshold", () => {
    const result = validateDecision(decision({ confidence: 0.8 }), QUESTION, 0.8);
    expect(result.ok).toBe(true);
  });
});
