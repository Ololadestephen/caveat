import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { fetchBoxFile, findFolderByName, listFolder } from "../../src/evidence/box.ts";
import { detectFlags } from "../../src/evidence/flags.ts";
import { extractPdfLines } from "../../src/evidence/pdf-text.ts";
import { extractSections } from "../../src/evidence/sections.ts";
import type { ContractSection } from "../../src/evidence/sections.ts";
import { OpenRouterDecisionProvider } from "../../src/interpret/openrouter.ts";
import { OpenRouterScheduleExtractor } from "../../src/interpret/schedule.ts";
import type { ScheduleOutcome } from "../../src/interpret/schedule.ts";
import { RELEASE_TIMING } from "../../src/interpret/types.ts";
import type { DecisionOutcome, Excerpt, Question } from "../../src/interpret/types.ts";
import { buildTwinveeInputs, policyAdjustments, PlanError } from "../../src/plan/twinvee.ts";
import type { TwinveeAssumptions } from "../../src/plan/twinvee.ts";
import { RECEIPT_VERSION } from "../../src/review/receipt.ts";
import type { RunReceipt } from "../../src/review/receipt.ts";
import {
  validateRetainerReview,
  validateSourcedOverride,
} from "../../src/review/human-review.ts";
import type {
  RetainerReview,
  SourcedOverride,
} from "../../src/review/human-review.ts";
import { renderReviewPage } from "../../src/review/review-page.ts";
import { canonicalJson } from "../../src/runner/digest.ts";
import { runFixture } from "../../src/runner/run.ts";
import { validateRunInput } from "../../src/runner/validate.ts";

const GATEWAY_LIST_URL = "https://api.sprites.dev/v1/gateway/list";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";

const FILE_NAMES = [
  "01-consulting-agreement.pdf",
  "02-first-amendment.pdf",
  "03-second-amendment.pdf",
];

const EDGAR_URLS: Record<string, string> = {
  "01-consulting-agreement.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm",
  "02-first-amendment.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm",
  "03-second-amendment.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226001331/e8000_ex10-1.htm",
};

const EXPECTED_FILES: Record<string, string> = {
  retainer_superseded: "fixtures/runner/twinvee-escrow.expected.json",
  retainer_continues: "fixtures/runner/twinvee-escrow-retainer-continues.expected.json",
};

const READING_LABELS: Record<string, string> = {
  retainer_superseded: "Retainer superseded",
  retainer_continues: "Retainer continues",
};

type Connection = { provider: string; gatewayBaseUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listConnections(): Promise<Connection[]> {
  const response = await fetch(GATEWAY_LIST_URL);
  if (!response.ok) throw new Error(`gateway list returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new Error("gateway list response lacked connections");
  }
  const connections: Connection[] = [];
  for (const entry of body.connections) {
    if (
      isRecord(entry) &&
      typeof entry.provider === "string" &&
      typeof entry.gateway_base_url === "string"
    ) {
      connections.push({ provider: entry.provider, gatewayBaseUrl: entry.gateway_base_url });
    }
  }
  return connections;
}

function stepError(step: string, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ status: "error", step, detail }));
  process.exit(1);
}

const runId =
  process.env.CAVEAT_RUN_ID ??
  `m3-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
const reviewsDir = process.env.CAVEAT_REVIEWS_DIR ?? "reviews";
const outDir = process.env.CAVEAT_RUN_DIR ?? `/home/sprite/caveat-runs/${runId}`;
const timings: Record<string, number> = {};
function timed<T>(step: string, started: number, value: T): T {
  timings[step] = Math.round(performance.now() - started);
  return value;
}

const totalStarted = performance.now();

// --- Connectors -------------------------------------------------------------
let started = performance.now();
const connections = await listConnections().catch((e) => stepError("gateway_list", e));
const boxConn = connections.find((c) => c.provider === "box");
const openrouterConn = connections.find((c) => c.provider === "openrouter");
if (boxConn === undefined) stepError("box", new Error("box connector not configured"));
if (openrouterConn === undefined) {
  stepError("openrouter", new Error("openrouter connector not configured"));
}
timed("gateway_list", started, null);

// --- Evidence: fetch all three PDFs from Box --------------------------------
started = performance.now();
const folderName = process.env.CAVEAT_BOX_FOLDER ?? "caveat_TEST";
const folder = await findFolderByName(boxConn.gatewayBaseUrl, "0", folderName).catch((e) =>
  stepError("box_folder", e),
);
if (folder === undefined) stepError("box_folder", new Error(`folder ${folderName} not found`));
const entries = await listFolder(boxConn.gatewayBaseUrl, folder.id).catch((e) =>
  stepError("box_list", e),
);
const fetched: {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  versionPresent: boolean;
}[] = [];
for (const fileName of FILE_NAMES) {
  const entry = entries.find((e) => e.type === "file" && e.name === fileName);
  if (entry === undefined) stepError("box_file", new Error(`${fileName} not in ${folderName}`));
  const evidence = await fetchBoxFile(boxConn.gatewayBaseUrl, entry.id).catch((e) =>
    stepError("box_fetch", e),
  );
  fetched.push({
    fileName: evidence.metadata.name,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    versionPresent: evidence.metadata.fileVersionId.length > 0,
  });
}
timed("box_fetch", started, null);

// --- PDF text -> sections ----------------------------------------------------
started = performance.now();
const sections: ContractSection[] = [];
const excerpts: Excerpt[] = [];
for (const file of fetched) {
  const pages = await extractPdfLines(file.bytes).catch((e) => stepError("pdf_text", e));
  const fileSections = extractSections(file.fileName, pages);
  sections.push(...fileSections);
  const versionLabel = `sha256 ${file.sha256.slice(0, 12)}`;
  for (const section of fileSections) {
    excerpts.push({
      id: `${file.fileName}#${section.sectionId}`,
      text: section.text,
      source: {
        fileName: file.fileName,
        versionLabel,
        page: section.pages[0],
        section: section.sectionId,
      },
    });
  }
}
if (sections.length === 0) stepError("sections", new Error("no contract sections extracted"));
timed("sections", started, null);

// --- Shared state ------------------------------------------------------------
const blockedReasons: { reason: string; detail: string }[] = [];
const model = process.env.CAVEAT_DECISION_MODEL ?? DEFAULT_MODEL;
const question: Question = { spec: RELEASE_TIMING, id: RELEASE_TIMING.id, excerpts };

// --- Typed decision: release_timing -----------------------------------------
started = performance.now();
const provider = new OpenRouterDecisionProvider({ gatewayBaseUrl: openrouterConn.gatewayBaseUrl, model });
const decision: DecisionOutcome = await provider.decide(question);
timed("release_timing", started, null);

// --- Typed extraction: escrow schedule ---------------------------------------
started = performance.now();
const extractor = new OpenRouterScheduleExtractor({
  gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
  model,
});
const schedule: ScheduleOutcome = await extractor.extract({ id: "escrow_schedule", excerpts });
timed("schedule", started, null);

// --- Flags -------------------------------------------------------------------
started = performance.now();
const flags = detectFlags(sections);
timed("flags", started, null);

// --- Human review ------------------------------------------------------------
started = performance.now();
let humanReview: RunReceipt["humanReview"];
let review: RetainerReview | undefined;
try {
  const raw: unknown = JSON.parse(await readFile(`${reviewsDir}/retainer-review.json`, "utf8"));
  const validated = validateRetainerReview(raw, sections);
  if (validated.ok) {
    review = validated.value;
    humanReview = { status: "ok", review: validated.value };
  } else {
    humanReview = { status: "needs_review", reason: validated.reason, detail: validated.detail };
    blockedReasons.push({ reason: validated.reason, detail: validated.detail });
  }
} catch (error) {
  humanReview = {
    status: "needs_review",
    reason: "review_citation_invalid",
    detail: `retainer review file unreadable: ${error instanceof Error ? error.message : String(error)}`,
  };
  blockedReasons.push({ reason: "review_citation_invalid", detail: "review file unreadable" });
}

// Optional sourced override for a needs_review release_timing decision.
const overrides: SourcedOverride[] = [];
try {
  const rawOverride: unknown = JSON.parse(
    await readFile(`${reviewsDir}/release-timing-override.json`, "utf8"),
  );
  const validated = validateSourcedOverride(rawOverride, sections);
  if (validated.ok) overrides.push(validated.value);
  else {
    blockedReasons.push({ reason: validated.reason, detail: `override: ${validated.detail}` });
  }
} catch {
  // No override supplied — the run stays blocked if the decision needs review.
}
timed("human_review", started, null);

// --- Effective action ---------------------------------------------------------
const override = overrides.find((o) => o.questionId === RELEASE_TIMING.id);
let effectiveAction: string | null = null;
if (decision.status === "decided") {
  effectiveAction = decision.decision.action;
} else {
  blockedReasons.push({ reason: decision.reason, detail: decision.detail });
  if (override !== undefined) effectiveAction = override.answer;
}
if (effectiveAction !== null && !RELEASE_TIMING.actions.includes(effectiveAction)) {
  blockedReasons.push({
    reason: "unsupported_release_timing",
    detail: `action ${effectiveAction} is not a release_timing answer`,
  });
} else if (effectiveAction !== null && effectiveAction !== "escrow_release") {
  blockedReasons.push({
    reason: "unsupported_release_timing",
    detail: `release_timing resolved to ${effectiveAction}; only escrow_release is modeled`,
  });
}
if (schedule.status === "needs_review") {
  blockedReasons.push({ reason: schedule.reason, detail: schedule.detail });
}
if (review !== undefined && review.baseRetainer.answer !== "unresolved_compare_both") {
  blockedReasons.push({
    reason: "unsupported_review_answer",
    detail: `baseRetainer.answer is ${review.baseRetainer.answer}; only unresolved_compare_both is modeled`,
  });
}

// --- Runner inputs + results ---------------------------------------------------
started = performance.now();
const readings: RunReceipt["readings"] = [];
const canRun =
  schedule.status === "extracted" &&
  review !== undefined &&
  effectiveAction === "escrow_release";
if (canRun && schedule.status === "extracted" && review !== undefined) {
  try {
    const assumptions: unknown = JSON.parse(
      await readFile("fixtures/plan/twinvee-demo-assumptions.json", "utf8"),
    );
    const inputs = buildTwinveeInputs({
      schedule: schedule.schedule,
      review,
      assumptions: assumptions as TwinveeAssumptions,
    });
    for (const [id, rawInput] of Object.entries(inputs)) {
      const input = validateRunInput(rawInput);
      const out = runFixture(input);
      const expectedRaw: unknown = JSON.parse(await readFile(EXPECTED_FILES[id]!, "utf8"));
      if (!isRecord(expectedRaw) || !isRecord(expectedRaw.results)) {
        throw new Error(`expected fixture ${EXPECTED_FILES[id]} malformed`);
      }
      if (!isDeepStrictEqual(out.results, expectedRaw.results)) {
        blockedReasons.push({
          reason: "results_mismatch",
          detail: `${id} results differ from ${EXPECTED_FILES[id]}`,
        });
      }
      if (!isDeepStrictEqual(out.smallestPassingCandidate, expectedRaw.smallestPassingCandidate)) {
        blockedReasons.push({
          reason: "results_mismatch",
          detail: `${id} smallestPassingCandidate differs from ${EXPECTED_FILES[id]}`,
        });
      }
      readings.push({
        id,
        label: READING_LABELS[id] ?? id,
        inputDigest: out.inputDigest,
        resultDigest: out.resultDigest,
        smallestPassingCandidate: out.smallestPassingCandidate,
        results: out.results,
        adjustments: input.scenarios.map((s) => ({
          scenarioId: s.id,
          adjustments: policyAdjustments(input, s),
        })),
      });
    }
  } catch (error) {
    const reason = error instanceof PlanError ? error.code : "runner_error";
    blockedReasons.push({
      reason,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
timed("runner", started, null);
timings.total = Math.round(performance.now() - totalStarted);

// --- Receipt + page -------------------------------------------------------------
const receipt: RunReceipt = {
  receiptVersion: RECEIPT_VERSION,
  runId,
  status: blockedReasons.length === 0 ? "reviewable" : "needs_review",
  blockedReasons,
  questionIds: [RELEASE_TIMING.id, "retainer_after_second_amendment"],
  sources: fetched.map((f) => ({
    fileName: f.fileName,
    versionLabel: `sha256 ${f.sha256.slice(0, 12)}`,
    versionPresent: f.versionPresent,
    edgarUrl: EDGAR_URLS[f.fileName] ?? null,
  })),
  releaseTiming: { outcome: decision, question },
  effectiveAction,
  overrides,
  schedule: { outcome: schedule, excerpts },
  humanReview,
  flags,
  readings,
};

await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/receipt.json`, `${canonicalJson(receipt)}\n`);
await writeFile(`${outDir}/review.html`, renderReviewPage(receipt));

console.log(
  JSON.stringify({
    status: receipt.status,
    runId,
    outDir,
    blockedReasons,
    effectiveAction,
    model,
    modelVersion: decision.modelVersion ?? schedule.modelVersion,
    servedBy: decision.servedBy ?? schedule.servedBy,
    flags: flags.map((f) => `${f.fileName} ${f.sectionId}: ${f.quote}`),
    sections: sections.map((s) => `${s.fileName} ${s.sectionId} p${s.pages[0]}-${s.pages[1]}`),
    readings: readings.map((r) => ({
      id: r.id,
      inputDigest: r.inputDigest,
      resultDigest: r.resultDigest,
      smallestPassingCandidate: r.smallestPassingCandidate,
    })),
    timingsMs: timings,
  }),
);
process.exit(receipt.status === "reviewable" ? 0 : 2);
