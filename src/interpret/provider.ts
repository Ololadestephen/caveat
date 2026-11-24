import type { DecisionOutcome, Question } from "./types.ts";

export interface DecisionProvider {
  readonly name: string;
  decide(question: Question, options?: { signal?: AbortSignal }): Promise<DecisionOutcome>;
}
