import type { BillingTriggerQuestion } from "./types.ts";

export const DECISION_SYSTEM_PROMPT = [
  "You decide a billing-trigger question about supplied contract excerpts.",
  "Answer only from the supplied excerpts; never use outside knowledge.",
  "Quote the cited clause verbatim from one supplied excerpt.",
  "Choose \"ambiguous\" whenever the excerpts do not clearly support a single action.",
  "Do no arithmetic, set no prices, and do not predict payment behaviour.",
  "confidence is your self-reported confidence from 0 to 1, not a calibrated probability.",
  "Respond with a single JSON object matching the requested schema.",
].join("\n");

export function buildDecisionUserPrompt(question: BillingTriggerQuestion): string {
  const excerpts = question.excerpts
    .map(
      (e) =>
        `<excerpt id="${e.id}" file="${e.source.fileName}" version="${e.source.versionLabel}" page="${e.source.page}">\n${e.text}\n</excerpt>`,
    )
    .join("\n");
  return [
    `Question ${question.questionId}: does the contract text trigger billing on delivery,`,
    "on client acceptance, or is it ambiguous?",
    "",
    excerpts,
  ].join("\n");
}
