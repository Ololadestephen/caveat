// Picks the pipeline path for the run's contract profile: the escrow path
// (twinvee — byte-identical to before profiles existed) or the generic
// payment-terms path.
import { contractProfile, DEFAULT_CONTRACT } from "../contracts/profiles.ts";
import { runGenericPipeline } from "./generic-pipeline.ts";
import { runPipeline } from "./run-pipeline.ts";
import type { PipelineConfig, PipelineResult } from "./run-pipeline.ts";

export async function dispatchPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const profile = contractProfile(config.contract ?? DEFAULT_CONTRACT);
  if (profile === undefined) {
    throw new Error(`unknown contract profile ${JSON.stringify(config.contract)}`);
  }
  if (profile.path === "payment_terms") return runGenericPipeline(config);
  return runPipeline(config);
}
