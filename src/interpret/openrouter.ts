import { callStructuredChat, chatConfig, modelInfo } from "./chat.ts";
import { decisionSchema } from "./schema.ts";
import { validateDecision } from "./validate.ts";
import { DECISION_SYSTEM_PROMPT, buildDecisionUserPrompt } from "./prompt.ts";
import type { DecisionProvider } from "./provider.ts";
import type { Decision, DecisionOutcome, NeedsReviewReason, Question } from "./types.ts";

export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;

export type OpenRouterProviderConfig = {
  gatewayBaseUrl: string;
  model?: string;
  threshold?: number;
  timeoutMs?: number;
  allowedModelVersions?: string[];
  fetch?: typeof fetch;
};

export class OpenRouterDecisionProvider implements DecisionProvider {
  readonly name = "openrouter";
  private readonly model: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly allowedModelVersions: string[] | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayBaseUrl: string;

  constructor(config: OpenRouterProviderConfig) {
    this.gatewayBaseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_OPENROUTER_MODEL;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowedModelVersions = config.allowedModelVersions;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async decide(
    question: Question,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionOutcome> {
    const fail = (
      reason: NeedsReviewReason,
      detail: string,
      extra?: { modelVersion?: string; servedBy?: string; decision?: Decision },
    ): DecisionOutcome => ({
      status: "needs_review",
      reason,
      detail,
      provider: this.name,
      model: this.model,
      ...extra,
    });

    const result = await callStructuredChat(
      chatConfig(this.gatewayBaseUrl, this.timeoutMs, this.allowedModelVersions, this.fetchImpl),
      {
        model: this.model,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        userPrompt: buildDecisionUserPrompt(question),
        schemaName: `${question.spec.id}_decision`,
        schema: decisionSchema(question.spec.actions),
      },
      options,
    );

    if (!result.ok) {
      return fail(result.reason, result.detail, modelInfo(result));
    }

    const context = modelInfo(result);
    const validation = validateDecision(result.parsed, question, this.threshold);
    if (!validation.ok) {
      return fail(validation.reason, validation.detail, {
        ...context,
        ...(validation.decision !== undefined ? { decision: validation.decision } : {}),
      });
    }
    return {
      status: "decided",
      decision: validation.decision,
      provider: this.name,
      model: this.model,
      ...context,
      latencyMs: result.latencyMs,
    };
  }
}
