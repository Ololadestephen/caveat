import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { listConnections } from "../gateway.ts";
import { isRecord } from "../shape.ts";
import type { Connection } from "../gateway.ts";

import { fetchBoxFile, findFolderByName, listFolder } from "../evidence/box.ts";
import { detectFlags } from "../evidence/flags.ts";
import { extractPdfLines } from "../evidence/pdf-text.ts";
import { extractSections } from "../evidence/sections.ts";
import type { ContractSection } from "../evidence/sections.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { OpenRouterDecisionProvider } from "../interpret/openrouter.ts";
import { OpenRouterScheduleExtractor } from "../interpret/schedule.ts";
import type { ScheduleOutcome } from "../interpret/schedule.ts";
import { RELEASE_TIMING } from "../interpret/types.ts";
import type { DecisionOutcome, Excerpt, Question } from "../interpret/types.ts";
import {
  buildTwinveeInputs,
  escrowRules,
  policyAdjustments,
  PlanError,
} from "../plan/twinvee.ts";
import type { TwinveeAssumptions } from "../plan/twinvee.ts";
import { RECEIPT_VERSION } from "../review/receipt.ts";
import type { RunReceipt } from "../review/receipt.ts";
import {
  validateRetainerReview,
  validateSourcedOverride,
} from "../review/human-review.ts";
import type {
  RetainerReview,
  SourcedOverride,
} from "../review/human-review.ts";
import { runFixture } from "../runner/run.ts";
import { validateRunInput } from "../runner/validate.ts";
import { chatConfig } from "../interpret/chat.ts";
import type { callStructuredChat } from "../interpret/chat.ts";
import { buildSearchBase } from "../search/levers.ts";
import { runCounterofferSearch } from "../search/loop.ts";
import type { CounterofferReceipt, SearchReading } from "../search/loop.ts";
import { SpritesExecPool } from "../worker/pool.ts";
import type { WorkerPool } from "../worker/pool.ts";

const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const DEFAULT_WORKERS_CONNECTOR = "caveat-workers";
const DEFAULT_WORKERS = "caveat-wa,caveat-wb";
const SEARCH_TIMEOUT_MS = 60_000;

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
  retainer_superseded: "runner/twinvee-escrow.expected.json",
  retainer_continues: "runner/twinvee-escrow-retainer-continues.expected.json",
};

const READING_LABELS: Record<string, string> = {
  retainer_superseded: "Retainer superseded",
  retainer_continues: "Retainer continues",
};

export type PipelineConfig = {
  runId: string;
  // Paths resolve relative to the process cwd (the deployed app directory).
  reviewsDir: string;
  fixturesDir: string;
  boxFolder?: string;
  decisionModel?: string;
  operativeFile?: string;
  assertExpected?: boolean;
  connections?: Connection[];
  pdfText?: typeof extractPdfLines;
  workerPool?: WorkerPool;
  workersConnector?: string;
  workers?: string;
  chat?: typeof callStructuredChat;
};

export type PipelineResult = {
  receipt: RunReceipt;
  sourceTuple: SourceTuple;
  sections: ContractSection[];
  timingsMs: Record<string, number>;
};

class PipelineError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PipelineError";
    this.step = step;
  }
}

// Per-run wall-clock timings keyed by stage name.
class StageTimer {
  readonly timings: Record<string, number> = {};
  private readonly totalStarted = performance.now();
  private stageStarted = performance.now();

  // Tag a rejected promise with the pipeline step that produced it.
  step<T>(name: string, p: Promise<T>): Promise<T> {
    return p.catch((error: unknown) => {
      throw error instanceof PipelineError ? error : new PipelineError(name, error);
    });
  }

  begin(): void {
    this.stageStarted = performance.now();
  }

  record(name: string): void {
    this.timings[name] = Math.round(performance.now() - this.stageStarted);
  }

  finish(): void {
    this.timings.total = Math.round(performance.now() - this.totalStarted);
  }
}

type Connectors = {
  boxConn: Connection;
  openrouterConn: Connection;
  workersConn: Connection | undefined;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function connect(config: PipelineConfig, timer: StageTimer): Promise<Connectors> {
  const connections =
    config.connections ?? (await timer.step("gateway_list", listConnections()));
  const boxConn = connections.find((c) => c.provider === "box");
  const openrouterConn = connections.find((c) => c.provider === "openrouter");
  if (boxConn === undefined) throw new PipelineError("box", new Error("box connector not configured"));
  if (openrouterConn === undefined) {
    throw new PipelineError("openrouter", new Error("openrouter connector not configured"));
  }
  const workersName =
    config.workersConnector ?? readEnv("CAVEAT_WORKERS_CONNECTOR") ?? DEFAULT_WORKERS_CONNECTOR;
  const workersConn = connections.find((c) => c.name === workersName);
  return { boxConn, openrouterConn, workersConn };
}

type FetchedFile = {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  versionPresent: boolean;
};

async function fetchSources(
  boxConn: Connection,
  folderName: string,
  timer: StageTimer,
): Promise<{ sourceTuple: SourceTuple; fetched: FetchedFile[] }> {
  const folder = await timer.step(
    "box_folder",
    findFolderByName(boxConn.gatewayBaseUrl, "0", folderName),
  );
  if (folder === undefined) {
    throw new PipelineError("box_folder", new Error(`folder ${folderName} not found`));
  }
  const entries = await timer.step("box_list", listFolder(boxConn.gatewayBaseUrl, folder.id));
  const sourceTuple: SourceTuple = [];
  const fetched: FetchedFile[] = [];
  for (const fileName of FILE_NAMES) {
    const entry = entries.find((e) => e.type === "file" && e.name === fileName);
    if (entry === undefined) {
      throw new PipelineError("box_file", new Error(`${fileName} not in ${folderName}`));
    }
    const evidence = await timer.step("box_fetch", fetchBoxFile(boxConn.gatewayBaseUrl, entry.id));
    fetched.push({
      fileName: evidence.metadata.name,
      bytes: evidence.bytes,
      sha256: evidence.sha256,
      versionPresent: evidence.metadata.fileVersionId.length > 0,
    });
    sourceTuple.push({
      fileName: evidence.metadata.name,
      fileId: entry.id,
      versionId: evidence.metadata.fileVersionId,
      sha256: evidence.sha256,
      size: evidence.metadata.size,
    });
  }
  return { sourceTuple, fetched };
}

async function sectionize(
  fetched: FetchedFile[],
  pdfText: typeof extractPdfLines,
  timer: StageTimer,
): Promise<{ sections: ContractSection[]; excerpts: Excerpt[] }> {
  const sections: ContractSection[] = [];
  const excerpts: Excerpt[] = [];
  for (const file of fetched) {
    const pages = await timer.step("pdf_text", pdfText(file.bytes));
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
  if (sections.length === 0) {
    throw new PipelineError("sections", new Error("no contract sections extracted"));
  }
  return { sections, excerpts };
}

// The private human-review record plus any sourced overrides; failures block
// the run rather than abort it.
async function loadReviewArtifacts(
  reviewsDir: string,
  sections: ContractSection[],
  blockedReasons: { reason: string; detail: string }[],
): Promise<{
  humanReview: RunReceipt["humanReview"];
  review: RetainerReview | undefined;
  overrides: SourcedOverride[];
}> {
  let humanReview: RunReceipt["humanReview"];
  let review: RetainerReview | undefined;
  try {
    const raw: unknown = JSON.parse(
      await readFile(`${reviewsDir}/retainer-review.json`, "utf8"),
    );
    const validated = validateRetainerReview(raw, sections);
    if (validated.ok) {
      review = validated.value;
      humanReview = { status: "ok", review: validated.value };
    } else {
      humanReview = {
        status: "needs_review",
        reason: validated.reason,
        detail: validated.detail,
      };
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
  return { humanReview, review, overrides };
}

// Decide the effective release_timing action and collect the gate reasons that
// block the run.
function evaluateGates(
  decision: DecisionOutcome,
  schedule: ScheduleOutcome,
  review: RetainerReview | undefined,
  overrides: SourcedOverride[],
): { effectiveAction: string | null; reasons: { reason: string; detail: string }[] } {
  const reasons: { reason: string; detail: string }[] = [];
  const override = overrides.find((o) => o.questionId === RELEASE_TIMING.id);
  let effectiveAction: string | null = null;
  if (decision.status === "decided") {
    effectiveAction = decision.decision.action;
  } else {
    reasons.push({ reason: decision.reason, detail: decision.detail });
    if (override !== undefined) effectiveAction = override.answer;
  }
  if (effectiveAction !== null && !RELEASE_TIMING.actions.includes(effectiveAction)) {
    reasons.push({
      reason: "unsupported_release_timing",
      detail: `action ${effectiveAction} is not a release_timing answer`,
    });
  } else if (effectiveAction !== null && effectiveAction !== "escrow_release") {
    reasons.push({
      reason: "unsupported_release_timing",
      detail: `release_timing resolved to ${effectiveAction}; only escrow_release is modeled`,
    });
  }
  if (schedule.status === "needs_review") {
    reasons.push({ reason: schedule.reason, detail: schedule.detail });
  }
  if (review !== undefined && review.baseRetainer.answer !== "unresolved_compare_both") {
    reasons.push({
      reason: "unsupported_review_answer",
      detail: `baseRetainer.answer is ${review.baseRetainer.answer}; only unresolved_compare_both is modeled`,
    });
  }
  return { effectiveAction, reasons };
}

// Run both retainer readings through the deterministic runner and compare them
// to the committed expected fixtures unless assertExpected is false — a
// mismatch blocks the run rather than shipping wrong numbers.
async function runReadings(
  schedule: ScheduleOutcome,
  review: RetainerReview | undefined,
  effectiveAction: string | null,
  assumptions: TwinveeAssumptions,
  config: PipelineConfig,
): Promise<{
  readings: RunReceipt["readings"];
  inputs: Record<string, Record<string, unknown>>;
  reasons: { reason: string; detail: string }[];
}> {
  const readings: RunReceipt["readings"] = [];
  const inputs: Record<string, Record<string, unknown>> = {};
  const reasons: { reason: string; detail: string }[] = [];
  if (!(schedule.status === "extracted" && review !== undefined && effectiveAction === "escrow_release")) {
    return { readings, inputs, reasons };
  }
  try {
    const built = buildTwinveeInputs({ schedule: schedule.schedule, review, assumptions });
    for (const [id, rawInput] of Object.entries(built)) {
      inputs[id] = rawInput;
      const input = validateRunInput(rawInput);
      const out = runFixture(input);
      if (config.assertExpected !== false) {
        const expectedRaw: unknown = JSON.parse(
          await readFile(`${config.fixturesDir}/${EXPECTED_FILES[id]}`, "utf8"),
        );
        if (!isRecord(expectedRaw) || !isRecord(expectedRaw.results)) {
          throw new Error(`expected fixture ${EXPECTED_FILES[id]} malformed`);
        }
        if (!isDeepStrictEqual(out.results, expectedRaw.results)) {
          reasons.push({
            reason: "results_mismatch",
            detail: `${id} results differ from ${EXPECTED_FILES[id]}`,
          });
        }
        if (!isDeepStrictEqual(out.smallestPassingCandidate, expectedRaw.smallestPassingCandidate)) {
          reasons.push({
            reason: "results_mismatch",
            detail: `${id} smallestPassingCandidate differs from ${EXPECTED_FILES[id]}`,
          });
        }
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
    reasons.push({
      reason,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return { readings, inputs, reasons };
}

// Runs the counteroffer search after clean readings. Any model/worker failure
// comes back as a needs_review receipt and blocks the run — nothing throws
// here unless the stage itself breaks, which also blocks.
async function runSearchStage(
  schedule: Extract<ScheduleOutcome, { status: "extracted" }>,
  inputs: Record<string, Record<string, unknown>>,
  readings: RunReceipt["readings"],
  assumptions: TwinveeAssumptions,
  connectors: Connectors,
  model: string,
  config: PipelineConfig,
): Promise<CounterofferReceipt> {
  const base = buildSearchBase(
    schedule.schedule,
    escrowRules(schedule.schedule, assumptions.escrowFundingDate),
    assumptions.escrowFundingDate,
  );
  const searchReadings: SearchReading[] = readings.map((r) => ({
    id: r.id,
    label: r.label,
    rawInput: inputs[r.id] as SearchReading["rawInput"],
    asSignedResults: r.results.as_signed ?? {},
  }));
  let pool = config.workerPool;
  if (pool === undefined) {
    if (connectors.workersConn === undefined) {
      return {
        status: "needs_review",
        stopReason: "worker_error",
        reason: "workers_unavailable",
        detail: "the workers connector is not configured on the gateway",
        model,
        rounds: [],
        best: null,
        humanReview: [],
      };
    }
    const workerNames = (
      config.workers ?? readEnv("CAVEAT_WORKERS") ?? DEFAULT_WORKERS
    )
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    pool = new SpritesExecPool({
      gatewayBaseUrl: connectors.workersConn.gatewayBaseUrl,
      workers: workerNames,
    });
  }
  const conditionalReleases = schedule.schedule.releases
    .filter((r) => r.extensionId !== undefined)
    .map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      date: r.date,
      extensionId: r.extensionId as string,
    }));
  return runCounterofferSearch({
    base,
    readings: searchReadings,
    model,
    chatConfig: chatConfig(connectors.openrouterConn.gatewayBaseUrl, SEARCH_TIMEOUT_MS, undefined, fetch),
    pool,
    ...(config.chat !== undefined ? { chat: config.chat } : {}),
    conditionalReleases,
  });
}

async function loadAssumptions(fixturesDir: string): Promise<TwinveeAssumptions> {
  const raw = await readFile(`${fixturesDir}/plan/twinvee-demo-assumptions.json`, "utf8");
  return JSON.parse(raw) as TwinveeAssumptions;
}

// The evidence->decision->runner pipeline. The typed questions cover the
// operative (second) amendment; the other files' sections feed flags and
// human-review citation verification.
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const timer = new StageTimer();
  const blockedReasons: { reason: string; detail: string }[] = [];

  // --- Connectors -------------------------------------------------------------
  timer.begin();
  const connectors = await connect(config, timer);
  const { boxConn, openrouterConn } = connectors;
  timer.record("gateway_list");

  // --- Evidence: fetch all three PDFs -------------------------------------------
  timer.begin();
  const folderName = config.boxFolder ?? "caveat_TEST";
  const { sourceTuple, fetched } = await fetchSources(boxConn, folderName, timer);
  timer.record("box_fetch");

  // --- PDF text -> sections ------------------------------------------------------
  timer.begin();
  const { sections, excerpts } = await sectionize(fetched, config.pdfText ?? extractPdfLines, timer);
  timer.record("sections");

  const model = config.decisionModel ?? DEFAULT_MODEL;
  const operativeFile = config.operativeFile ?? "03-second-amendment.pdf";
  const decisionExcerpts = excerpts.filter((e) => e.source.fileName === operativeFile);
  if (decisionExcerpts.length === 0) {
    throw new PipelineError("sections", new Error(`no sections extracted from ${operativeFile}`));
  }
  const question: Question = {
    spec: RELEASE_TIMING,
    id: RELEASE_TIMING.id,
    excerpts: decisionExcerpts,
  };

  // --- Typed decision -------------------------------------------------------------
  timer.begin();
  const provider = new OpenRouterDecisionProvider({
    gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
    model,
  });
  const decision: DecisionOutcome = await provider.decide(question);
  timer.record("release_timing");

  // --- Typed extraction --------------------------------------------------------------
  timer.begin();
  const extractor = new OpenRouterScheduleExtractor({
    gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
    model,
  });
  const schedule: ScheduleOutcome = await extractor.extract({
    id: "escrow_schedule",
    excerpts: decisionExcerpts,
  });
  timer.record("schedule");

  // --- Flags --------------------------------------------------------------------------
  timer.begin();
  const flags = detectFlags(sections);
  timer.record("flags");

  // --- Human review --------------------------------------------------------------------
  timer.begin();
  const { humanReview, review, overrides } = await loadReviewArtifacts(
    config.reviewsDir,
    sections,
    blockedReasons,
  );
  timer.record("human_review");

  // --- Gates + readings ------------------------------------------------------------
  const { effectiveAction, reasons } = evaluateGates(decision, schedule, review, overrides);
  blockedReasons.push(...reasons);

  timer.begin();
  const assumptions = await timer.step("assumptions", loadAssumptions(config.fixturesDir));
  const { readings, inputs, reasons: runnerReasons } = await runReadings(
    schedule,
    review,
    effectiveAction,
    assumptions,
    config,
  );
  blockedReasons.push(...runnerReasons);
  timer.record("runner");

  // --- Counteroffer search -----------------------------------------------------
  let counteroffer: CounterofferReceipt | undefined;
  if (
    blockedReasons.length === 0 &&
    readings.length > 0 &&
    schedule.status === "extracted"
  ) {
    timer.begin();
    try {
      counteroffer = await runSearchStage(
        schedule,
        inputs,
        readings,
        assumptions,
        connectors,
        model,
        config,
      );
    } catch (error) {
      counteroffer = {
        status: "needs_review",
        stopReason: "worker_error",
        reason: "counteroffer_error",
        detail: error instanceof Error ? error.message : String(error),
        model,
        rounds: [],
        best: null,
        humanReview: [],
      };
    }
    if (counteroffer.status === "needs_review") {
      blockedReasons.push({
        reason: counteroffer.reason ?? "counteroffer_needs_review",
        detail: counteroffer.detail ?? `counteroffer search stopped: ${counteroffer.stopReason}`,
      });
    }
    timer.record("counteroffer");
  }
  timer.finish();

  const receipt: RunReceipt = {
    receiptVersion: RECEIPT_VERSION,
    runId: config.runId,
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
    schedule: { outcome: schedule, excerpts: decisionExcerpts },
    humanReview,
    flags,
    readings,
    assumptions,
    ...(counteroffer !== undefined ? { counteroffer } : {}),
  };

  return { receipt, sourceTuple, sections, timingsMs: timer.timings };
}
