import { mkdir, writeFile } from "node:fs/promises";

import { runPipeline } from "../../src/pipeline/run-pipeline.ts";
import { renderReviewPage } from "../../src/review/review-page.ts";
import { canonicalJson } from "../../src/runner/digest.ts";

const runId =
  process.env.CAVEAT_RUN_ID ??
  `m3-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
const outDir = process.env.CAVEAT_RUN_DIR ?? `/home/sprite/caveat-runs/${runId}`;

let result;
try {
  result = await runPipeline({
    runId,
    reviewsDir: process.env.CAVEAT_REVIEWS_DIR ?? "reviews",
    fixturesDir: "fixtures",
    ...(process.env.CAVEAT_BOX_FOLDER !== undefined
      ? { boxFolder: process.env.CAVEAT_BOX_FOLDER }
      : {}),
    ...(process.env.CAVEAT_DECISION_MODEL !== undefined
      ? { decisionModel: process.env.CAVEAT_DECISION_MODEL }
      : {}),
    ...(process.env.CAVEAT_OPERATIVE_FILE !== undefined
      ? { operativeFile: process.env.CAVEAT_OPERATIVE_FILE }
      : {}),
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const step =
    error instanceof Error && "step" in error
      ? String((error as { step: unknown }).step)
      : "pipeline";
  console.log(JSON.stringify({ status: "error", step, detail }));
  process.exit(1);
}

const { receipt, sections, timingsMs } = result;

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/receipt.json`, `${canonicalJson(receipt)}\n`);
await writeFile(`${outDir}/review.html`, renderReviewPage(receipt));

const decision = receipt.releaseTiming?.outcome;
const schedule = receipt.schedule?.outcome;
console.log(
  JSON.stringify({
    status: receipt.status,
    runId,
    outDir,
    blockedReasons: receipt.blockedReasons,
    effectiveAction: receipt.effectiveAction,
    model: decision?.model ?? schedule?.model,
    modelVersion: decision?.modelVersion ?? schedule?.modelVersion,
    servedBy: decision?.servedBy ?? schedule?.servedBy,
    flags: receipt.flags.map((f) => `${f.fileName} ${f.sectionId}: ${f.quote}`),
    sections: sections.map((s) => `${s.fileName} ${s.sectionId} p${s.pages[0]}-${s.pages[1]}`),
    readings: receipt.readings.map((r) => ({
      id: r.id,
      inputDigest: r.inputDigest,
      resultDigest: r.resultDigest,
      smallestPassingCandidate: r.smallestPassingCandidate,
    })),
    timingsMs,
  }),
);
process.exit(receipt.status === "reviewable" ? 0 : 2);
