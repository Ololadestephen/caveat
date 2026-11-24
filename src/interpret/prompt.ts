import type { Excerpt, Question } from "./types.ts";

export const DECISION_SYSTEM_PROMPT = `You answer one typed question about supplied contract excerpts.
Answer only from the supplied excerpts; never use outside knowledge.
Quote the cited clause verbatim from one supplied excerpt.
Choose "ambiguous" whenever the excerpts do not clearly support exactly one answer.
Do no arithmetic, set no prices, and do not predict payment behaviour.
confidence is your self-reported confidence from 0 to 1, not a calibrated probability.
Respond with a single JSON object matching the requested schema.`;

export function excerptTags(excerpts: Excerpt[]): string {
  return excerpts
    .map((e) => {
      const section =
        e.source.section !== undefined ? ` section="${e.source.section}"` : "";
      return `<excerpt id="${e.id}" file="${e.source.fileName}" version="${e.source.versionLabel}" page="${e.source.page}"${section}>\n${e.text}\n</excerpt>`;
    })
    .join("\n");
}

export function buildDecisionUserPrompt(question: Question): string {
  return [
    `Question ${question.id}: ${question.spec.questionText}`,
    "",
    excerptTags(question.excerpts),
  ].join("\n");
}
