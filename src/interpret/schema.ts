export const REASON_MAX_LENGTH = 500;
export const QUOTE_MAX_LENGTH = 600;

export function decisionSchema(actions: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "reason", "cited_clause", "confidence"],
    properties: {
      action: { type: "string", enum: [...actions] },
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
}
