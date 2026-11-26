import { createHash } from "node:crypto";
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
import { versionTag, sha12 } from "../evidence/recheck.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { DECISION_SYSTEM_PROMPT } from "../interpret/prompt.ts";
import { OpenRouterDecisionProvider } from "../interpret/openrouter.ts";
import { decisionSchema } from "../interpret/schema.ts";
import {
  OpenRouterScheduleExtractor,
  SCHEDULE_JSON_SCHEMA,
} from "../interpret/schedule.ts";
import type { ScheduleOutcome } from "../interpret/schedule.ts";
import { RELEASE_TIMING } from "../interpret/types.ts";
import type { DecisionOutcome, Excerpt, Question } from "../interpret/types.ts";
import { parseCashFile } from "../plan/cash-file.ts";
import {
  buildTwinveeInputs,
  escrowRules,
  policyAdjustments,
  PlanError,
} from "../plan/twinvee.ts";
import type { TwinveeAssumptions } from "../plan/twinvee.ts";
import { RECEIPT_VERSION } from "../review/receipt.ts";
import type { IncrementalInfo, RunReceipt } from "../review/receipt.ts";
import {
  validateRetainerReview,
  validateSourcedOverride,
} from "../review/human-review.ts";
import type {
  RetainerReview,
  SourcedOverride,
} from "../review/human-review.ts";
import { digestValue } from "../runner/digest.ts";
import { runFixture } from "../runner/run.ts";
import { validateRunInput } from "../runner/validate.ts";
import { chatConfig } from "../interpret/chat.ts";
import type { callStructuredChat } from "../interpret/chat.ts";
import { buildSearchBase } from "../search/levers.ts";
import type { SearchBase } from "../search/levers.ts";
import {
  counterofferCallDigest,
  reverifyBestCandidate,
  runCounterofferSearch,
} from "../search/loop.ts";
import type {
  CounterofferReceipt,
  SearchCandidateRecord,
  SearchReading,
} from "../search/loop.ts";
import { SpritesHttpPool } from "../worker/pool.ts";
import type { WorkerPool } from "../worker/pool.ts";

const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
// worker display name = connector name; the connector points at that worker's
// org-private Sprite URL.
const DEFAULT_WORKERS = "caveat-wa=caveat-worker-a,caveat-wb=caveat-worker-b";
// The free model needs about two minutes for one search round (observed
// 113 s on 2026-11-25), so the per-round ceiling is well above that.
const DEFAULT_SEARCH_TIMEOUT_MS = 240_000;

function searchTimeoutMs(): number {
  const parsed = Number(readEnv("CAVEAT_SEARCH_TIMEOUT_MS"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEARCH_TIMEOUT_MS;
}

const FILE_NAMES = [
  "01-consulting-agreement.pdf",
  "02-first-amendment.pdf",
  "03-second-amendment.pdf",
];

// Optional owner-provided cash numbers. Fetched and versioned like the PDFs
// but never sectionized.
const CASH_FILE_NAME = "my-cash.csv";

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
  workers?: string;
  chat?: typeof callStructuredChat;
  trigger?: "manual" | "watcher";
  // The run this one is based on. When its receipt carries digests, matching
  // typed calls reuse the previous outcomes instead of re-asking the model.
  previous?: { runId: string; receipt: RunReceipt; sourceTuple: SourceTuple };
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
  all: Connection[];
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
  return { boxConn, openrouterConn, all: connections };
}

// "worker=connector" entries; a bare name uses it as both.
function parseWorkerSpec(spec: string): { worker: string; connector: string }[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const eq = entry.indexOf("=");
      return eq === -1
        ? { worker: entry, connector: entry }
        : { worker: entry.slice(0, eq).trim(), connector: entry.slice(eq + 1).trim() };
    });
}

type FetchedFile = {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  versionPresent: boolean;
};

type CashFetched = FetchedFile & { fileId: string; versionId: string };

async function fetchSources(
  boxConn: Connection,
  folderName: string,
  timer: StageTimer,
): Promise<{ sourceTuple: SourceTuple; fetched: FetchedFile[]; cashFile: CashFetched | undefined }> {
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
  let cashFile: CashFetched | undefined;
  const cashEntry = entries.find((e) => e.type === "file" && e.name === CASH_FILE_NAME);
  if (cashEntry !== undefined) {
    const evidence = await timer.step(
      "box_fetch",
      fetchBoxFile(boxConn.gatewayBaseUrl, cashEntry.id),
    );
    cashFile = {
      fileName: evidence.metadata.name,
      fileId: cashEntry.id,
      versionId: evidence.metadata.fileVersionId,
      bytes: evidence.bytes,
      sha256: evidence.sha256,
      versionPresent: evidence.metadata.fileVersionId.length > 0,
    };
    sourceTuple.push({
      fileName: evidence.metadata.name,
      fileId: cashEntry.id,
      versionId: evidence.metadata.fileVersionId,
      sha256: evidence.sha256,
      size: evidence.metadata.size,
    });
  }
  return { sourceTuple, fetched, cashFile };
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
  expectedEligible: boolean,
  config: PipelineConfig,
): Promise<{
  readings: RunReceipt["readings"];
  inputs: Record<string, Record<string, unknown>>;
  reasons: { reason: string; detail: string }[];
  expectedCheck?: RunReceipt["expectedCheck"];
}> {
  const readings: RunReceipt["readings"] = [];
  const inputs: Record<string, Record<string, unknown>> = {};
  const reasons: { reason: string; detail: string }[] = [];
  if (!(schedule.status === "extracted" && review !== undefined && effectiveAction === "escrow_release")) {
    return { readings, inputs, reasons };
  }
  let expectedCheck: RunReceipt["expectedCheck"];
  try {
    const built = buildTwinveeInputs({ schedule: schedule.schedule, review, assumptions });
    for (const [id, rawInput] of Object.entries(built)) {
      inputs[id] = rawInput;
      const input = validateRunInput(rawInput);
      const out = runFixture(input);
      if (!expectedEligible) {
        expectedCheck = "skipped_custom_cash";
      } else if (config.assertExpected !== false) {
        const expectedRaw: unknown = JSON.parse(
          await readFile(`${config.fixturesDir}/${EXPECTED_FILES[id]}`, "utf8"),
        );
        if (!isRecord(expectedRaw) || !isRecord(expectedRaw.results)) {
          throw new Error(`expected fixture ${EXPECTED_FILES[id]} malformed`);
        }
        expectedCheck ??= "matched";
        if (!isDeepStrictEqual(out.results, expectedRaw.results)) {
          expectedCheck = "mismatch";
          reasons.push({
            reason: "results_mismatch",
            detail: `${id} results differ from ${EXPECTED_FILES[id]}`,
          });
        }
        if (!isDeepStrictEqual(out.smallestPassingCandidate, expectedRaw.smallestPassingCandidate)) {
          expectedCheck = "mismatch";
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
  return { readings, inputs, reasons, expectedCheck };
}

// The deterministic search inputs — built before deciding whether to carry a
// previous outcome, since the digest covers exactly these.
function prepareSearch(
  schedule: Extract<ScheduleOutcome, { status: "extracted" }>,
  inputs: Record<string, Record<string, unknown>>,
  readings: RunReceipt["readings"],
  assumptions: TwinveeAssumptions,
): { base: SearchBase; searchReadings: SearchReading[] } {
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
  return { base, searchReadings };
}

function workersUnavailableReceipt(model: string, detail: string): CounterofferReceipt {
  return {
    status: "needs_review",
    stopReason: "worker_error",
    reason: "workers_unavailable",
    detail,
    model,
    rounds: [],
    best: null,
    humanReview: [],
  };
}

// The worker pool: injected in tests, otherwise one Custom API connector per
// worker pointing at that worker's org-private Sprite URL.
function resolvePool(
  connectors: Connectors,
  model: string,
  config: PipelineConfig,
): { ok: true; pool: WorkerPool } | { ok: false; receipt: CounterofferReceipt } {
  if (config.workerPool !== undefined) return { ok: true, pool: config.workerPool };
  const gateways: Record<string, string> = {};
  for (const { worker, connector } of parseWorkerSpec(
    config.workers ?? readEnv("CAVEAT_WORKERS") ?? DEFAULT_WORKERS,
  )) {
    const conn = connectors.all.find((c) => c.name === connector);
    if (conn === undefined) {
      return {
        ok: false,
        receipt: workersUnavailableReceipt(
          model,
          `the ${connector} connector is not configured on the gateway`,
        ),
      };
    }
    gateways[worker] = conn.gatewayBaseUrl;
  }
  return { ok: true, pool: new SpritesHttpPool({ gateways }) };
}

// Runs the counteroffer search after clean readings. Any model/worker failure
// comes back as a needs_review receipt and blocks the run — nothing throws
// here unless the stage itself breaks, which also blocks.
async function runSearchStage(
  schedule: Extract<ScheduleOutcome, { status: "extracted" }>,
  prepared: { base: SearchBase; searchReadings: SearchReading[] },
  connectors: Connectors,
  model: string,
  config: PipelineConfig,
): Promise<CounterofferReceipt> {
  const resolved = resolvePool(connectors, model, config);
  if (!resolved.ok) return resolved.receipt;
  const conditionalReleases = schedule.schedule.releases
    .filter((r) => r.extensionId !== undefined)
    .map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      date: r.date,
      extensionId: r.extensionId as string,
    }));
  return runCounterofferSearch({
    base: prepared.base,
    readings: prepared.searchReadings,
    model,
    chatConfig: chatConfig(connectors.openrouterConn.gatewayBaseUrl, searchTimeoutMs(), undefined, fetch),
    pool: resolved.pool,
    ...(config.chat !== undefined ? { chat: config.chat } : {}),
    conditionalReleases,
  });
}

// Carries a previous search outcome forward. A "found" search still re-verifies
// its best candidate on the first worker: the runner numbers must reproduce
// exactly, otherwise the run goes to needs_review.
async function carrySearch(
  previous: { runId: string; receipt: RunReceipt },
  prevSearch: CounterofferReceipt,
  prepared: { base: SearchBase; searchReadings: SearchReading[] },
  connectors: Connectors,
  model: string,
  config: PipelineConfig,
): Promise<{ receipt: CounterofferReceipt; carried: boolean }> {
  const carried: CounterofferReceipt = { ...prevSearch, carriedFrom: previous.runId };
  if (prevSearch.status !== "found") return { receipt: carried, carried: true };
  const best = prevSearch.rounds
    .flatMap((r) => r.candidates)
    .find((c): c is SearchCandidateRecord => c.id === prevSearch.best);
  if (best === undefined) {
    return {
      receipt: {
        ...carried,
        status: "needs_review",
        stopReason: "worker_error",
        reason: "carried_search_mismatch",
        detail: `carried search names best candidate ${prevSearch.best ?? "none"} but no such record exists`,
      },
      carried: false,
    };
  }
  const resolved = resolvePool(connectors, model, config);
  if (!resolved.ok) return { receipt: resolved.receipt, carried: false };
  const verified = await reverifyBestCandidate({
    base: prepared.base,
    readings: prepared.searchReadings,
    record: best,
    pool: resolved.pool,
  });
  if (!verified.ok) {
    return {
      receipt: {
        ...carried,
        status: "needs_review",
        stopReason: "worker_error",
        reason: verified.reason,
        detail: verified.detail,
      },
      carried: false,
    };
  }
  carried.reverifiedOn = verified.worker;
  return { receipt: carried, carried: true };
}

// File-level diff between two source tuples for the incremental receipt.
function diffFiles(
  previous: SourceTuple,
  next: SourceTuple,
): IncrementalInfo["changedFiles"] {
  const changed: IncrementalInfo["changedFiles"] = [];
  const nextByName = new Map(next.map((f) => [f.fileName, f]));
  for (const old of previous) {
    const now = nextByName.get(old.fileName);
    nextByName.delete(old.fileName);
    const fromTag = versionTag(old);
    const toTag = now === undefined ? null : versionTag(now);
    if (now === undefined || toTag !== fromTag || now.sha256 !== old.sha256) {
      changed.push({
        fileName: old.fileName,
        fromVersionTag: fromTag,
        toVersionTag: toTag,
        contentChanged: now === undefined || now.sha256 !== old.sha256,
      });
    }
  }
  for (const added of nextByName.values()) {
    changed.push({
      fileName: added.fileName,
      fromVersionTag: null,
      toVersionTag: versionTag(added),
      contentChanged: true,
    });
  }
  return changed;
}

function diffSectionDigests(
  previous: Record<string, string>,
  next: Record<string, string>,
): IncrementalInfo["changedSections"] {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const id of Object.keys(next)) {
    if (!(id in previous)) added.push(id);
    else if (previous[id] !== next[id]) changed.push(id);
  }
  for (const id of Object.keys(previous)) {
    if (!(id in next)) removed.push(id);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
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
  const { sourceTuple, fetched, cashFile } = await fetchSources(boxConn, folderName, timer);
  timer.record("box_fetch");

  // --- PDF text -> sections ------------------------------------------------------
  timer.begin();
  const { sections, excerpts } = await sectionize(fetched, config.pdfText ?? extractPdfLines, timer);
  timer.record("sections");

  // sha256 of each section's text, keyed by its excerpt id — the clause-level
  // diff baseline the next incremental run compares against.
  const sectionDigests: Record<string, string> = {};
  for (const section of sections) {
    sectionDigests[`${section.fileName}#${section.sectionId}`] = createHash("sha256")
      .update(section.text)
      .digest("hex");
  }

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

  // Digests of exactly what determines each typed call; a matching digest in
  // the previous run's receipt means its outcome can be reused verbatim.
  const excerptDigestInputs = decisionExcerpts.map((e) => ({ id: e.id, text: e.text }));
  const decisionCallDigest = digestValue({
    schemaName: `${question.spec.id}_decision`,
    schema: decisionSchema(question.spec.actions),
    systemPrompt: DECISION_SYSTEM_PROMPT,
    model,
    questionId: question.id,
    excerpts: excerptDigestInputs,
  });
  const scheduleCallDigest = digestValue({
    schemaName: "schedule_extraction",
    schema: SCHEDULE_JSON_SCHEMA,
    systemPrompt: DECISION_SYSTEM_PROMPT,
    model,
    questionId: "escrow_schedule",
    excerpts: excerptDigestInputs,
  });
  const previous = config.previous;
  const prevDigests = previous?.receipt.typedCallDigests;
  // Only a run whose own receipt passed every gate may lend its answers; a
  // blocked answer is always re-asked, never carried.
  const baselineOk =
    previous !== undefined &&
    previous.receipt.status === "reviewable" &&
    previous.receipt.sectionDigests !== undefined &&
    prevDigests !== undefined;
  const reran: string[] = [];
  const carriedForward: string[] = [];

  // --- Typed decision -------------------------------------------------------------
  timer.begin();
  const prevDecision = previous?.receipt.releaseTiming?.outcome;
  let decision: DecisionOutcome;
  if (
    baselineOk &&
    prevDigests.release_timing === decisionCallDigest &&
    prevDecision?.status === "decided"
  ) {
    decision = { ...prevDecision, carriedFrom: previous.runId };
    carriedForward.push("release_timing");
  } else {
    const provider = new OpenRouterDecisionProvider({
      gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
      model,
    });
    decision = await provider.decide(question);
    reran.push("release_timing");
  }
  timer.record("release_timing");

  // --- Typed extraction --------------------------------------------------------------
  timer.begin();
  const prevSchedule = previous?.receipt.schedule?.outcome;
  let schedule: ScheduleOutcome;
  if (
    baselineOk &&
    prevDigests.escrow_schedule === scheduleCallDigest &&
    prevSchedule?.status === "extracted"
  ) {
    schedule = { ...prevSchedule, carriedFrom: previous.runId };
    carriedForward.push("escrow_schedule");
  } else {
    const extractor = new OpenRouterScheduleExtractor({
      gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
      model,
    });
    schedule = await extractor.extract({
      id: "escrow_schedule",
      excerpts: decisionExcerpts,
    });
    reran.push("escrow_schedule");
  }
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
  const demoAssumptions = await timer.step(
    "assumptions",
    loadAssumptions(config.fixturesDir),
  );
  // The owner cash file replaces the demo numbers when present and valid. An
  // invalid file blocks the run rather than falling back silently.
  let assumptions = demoAssumptions;
  let cashSource: NonNullable<RunReceipt["cashSource"]> = { kind: "demo_assumptions" };
  let cashInvalid = false;
  if (cashFile !== undefined) {
    const parsed = parseCashFile(cashFile.bytes, demoAssumptions);
    if (!parsed.ok) {
      const detail = `line ${parsed.line}: ${parsed.code}: ${parsed.detail}`;
      cashInvalid = true;
      blockedReasons.push({ reason: "cash_file_invalid", detail });
      cashSource = {
        kind: "owner_file_invalid",
        fileName: cashFile.fileName,
        versionTag: versionTag({ fileId: cashFile.fileId, versionId: cashFile.versionId }),
        sha12: sha12(cashFile.sha256),
        detail,
      };
    } else {
      assumptions = parsed.assumptions;
      cashSource = {
        kind: "owner_file",
        fileName: cashFile.fileName,
        versionTag: versionTag({ fileId: cashFile.fileId, versionId: cashFile.versionId }),
        sha12: sha12(cashFile.sha256),
      };
    }
  }
  // The committed expected fixtures only apply while the effective cash
  // numbers deep-equal the demo file's.
  const cashNumbers = (a: TwinveeAssumptions) => ({
    startDate: a.startDate,
    openingCents: a.openingCents,
    floorCents: a.floorCents,
    costs: a.costs,
  });
  const expectedEligible = isDeepStrictEqual(
    cashNumbers(assumptions),
    cashNumbers(demoAssumptions),
  );
  // An invalid cash file produces no results: readings and the expected
  // check are skipped entirely, and nothing reaches the search.
  const { readings, inputs, reasons: runnerReasons, expectedCheck } = cashInvalid
    ? {
        readings: [],
        inputs: {},
        reasons: [] as { reason: string; detail: string }[],
        expectedCheck: undefined,
      }
    : await runReadings(
        schedule,
        review,
        effectiveAction,
        assumptions,
        expectedEligible,
        config,
      );
  blockedReasons.push(...runnerReasons);
  timer.record("runner");

  // --- Counteroffer search -----------------------------------------------------
  // The digest covers the compiled base + both readings' raw runner inputs, so
  // it is computed whenever those exist — even when an earlier blocker means
  // the search itself cannot run.
  const prepared =
    readings.length > 0 && schedule.status === "extracted"
      ? prepareSearch(schedule, inputs, readings, assumptions)
      : undefined;
  const searchCallDigest =
    prepared === undefined
      ? "none"
      : counterofferCallDigest({
          base: prepared.base,
          readings: prepared.searchReadings,
          model,
        });
  let counteroffer: CounterofferReceipt | undefined;
  if (
    blockedReasons.length === 0 &&
    prepared !== undefined &&
    schedule.status === "extracted"
  ) {
    timer.begin();
    try {
      const prevSearch = previous?.receipt.counteroffer;
      const canCarry =
        baselineOk &&
        prevDigests !== undefined &&
        prevDigests.counteroffer_search === searchCallDigest &&
        prevSearch !== undefined &&
        (prevSearch.status === "found" ||
          prevSearch.status === "not_found" ||
          prevSearch.status === "not_needed");
      if (canCarry && prevSearch !== undefined && previous !== undefined) {
        const carried = await carrySearch(
          previous,
          prevSearch,
          prepared,
          connectors,
          model,
          config,
        );
        counteroffer = carried.receipt;
        if (carried.carried) carriedForward.push("counteroffer_search");
      } else {
        counteroffer = await runSearchStage(schedule, prepared, connectors, model, config);
        reran.push("counteroffer_search");
      }
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

  const incremental: IncrementalInfo | undefined =
    previous === undefined
      ? undefined
      : {
          previousRunId: previous.runId,
          mode: baselineOk ? "incremental" : "full_no_baseline",
          changedFiles: diffFiles(previous.sourceTuple, sourceTuple),
          changedSections:
            previous.receipt.sectionDigests === undefined
              ? { added: [], removed: [], changed: [] }
              : diffSectionDigests(previous.receipt.sectionDigests, sectionDigests),
          totalSections: sections.length,
          reran,
          carriedForward,
        };

  const receipt: RunReceipt = {
    receiptVersion: RECEIPT_VERSION,
    runId: config.runId,
    trigger: config.trigger ?? "manual",
    status: blockedReasons.length === 0 ? "reviewable" : "needs_review",
    blockedReasons,
    questionIds: [RELEASE_TIMING.id, "retainer_after_second_amendment"],
    sources: [
      ...fetched.map((f) => ({
        fileName: f.fileName,
        versionLabel: `sha256 ${f.sha256.slice(0, 12)}`,
        versionPresent: f.versionPresent,
        edgarUrl: EDGAR_URLS[f.fileName] ?? null,
      })),
      ...(cashFile !== undefined
        ? [
            {
              fileName: cashFile.fileName,
              versionLabel: `sha256 ${cashFile.sha256.slice(0, 12)}`,
              versionPresent: cashFile.versionPresent,
              edgarUrl: null,
            },
          ]
        : []),
    ],
    cashSource,
    ...(expectedCheck !== undefined ? { expectedCheck } : {}),
    sectionDigests,
    typedCallDigests: {
      release_timing: decisionCallDigest,
      escrow_schedule: scheduleCallDigest,
      counteroffer_search: searchCallDigest,
    },
    releaseTiming: { outcome: decision, question },
    effectiveAction,
    overrides,
    schedule: { outcome: schedule, excerpts: decisionExcerpts },
    humanReview,
    flags,
    readings,
    assumptions,
    ...(counteroffer !== undefined ? { counteroffer } : {}),
    ...(incremental !== undefined ? { incremental } : {}),
  };

  return { receipt, sourceTuple, sections, timingsMs: timer.timings };
}
