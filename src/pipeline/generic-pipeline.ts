// The generic payment-terms path — filled in alongside the contract profile
// work; until then a non-escrow run fails cleanly instead of misrunning.
import type { PipelineConfig, PipelineResult } from "./run-pipeline.ts";

export function runGenericPipeline(config: PipelineConfig): Promise<PipelineResult> {
  void config;
  throw new Error("the payment_terms pipeline path is not implemented yet");
}
