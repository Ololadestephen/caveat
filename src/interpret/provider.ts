import type { BillingTriggerQuestion, DecisionOutcome } from "./types.ts";

export interface DecisionProvider {
  readonly name: string;
  decide(
    question: BillingTriggerQuestion,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionOutcome>;
}
