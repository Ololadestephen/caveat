// The strict response schema for the counteroffer-proposal chat call. Every
// field is required so strict-schema models always emit all fields; lever
// fields that do not apply must be null and are checked again at compile time.
export const PROPOSAL_SCHEMA_NAME = "counteroffer_proposal";

export const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["round_note", "done", "candidates"],
  properties: {
    round_note: { type: "string", maxLength: 400 },
    done: { type: "boolean" },
    candidates: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "lever",
          "amount_cents",
          "date",
          "split_count",
          "net_days",
          "rationale",
        ],
        properties: {
          lever: {
            type: "string",
            enum: [
              "upfront_deposit",
              "earlier_release",
              "milestone_split",
              "shorter_payment_terms",
            ],
          },
          amount_cents: { type: ["integer", "null"] },
          date: { type: ["string", "null"] },
          split_count: { type: ["integer", "null"] },
          net_days: { type: ["integer", "null"] },
          rationale: { type: "string", maxLength: 300 },
        },
      },
    },
  },
};
