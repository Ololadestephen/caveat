import { DECISION_ACTIONS } from "./types.ts";

export const REASON_MAX_LENGTH = 500;
export const QUOTE_MAX_LENGTH = 600;

export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "cited_clause", "confidence"],
  properties: {
    action: { type: "string", enum: [...DECISION_ACTIONS] },
    reason: { type: "string", maxLength: REASON_MAX_LENGTH },
    cited_clause: {
      type: "object",
      additionalProperties: false,
      required: ["excerpt_id", "quote"],
      properties: {
        excerpt_id: { type: "string" },
        quote: { type: "string", maxLength: QUOTE_MAX_LENGTH },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;
