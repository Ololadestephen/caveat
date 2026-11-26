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
import {
  buildCounterCrosscheckRequest,
  buildGateRequest,
  buildReleaseTimingDigestInput,
  buildScheduleCrosscheckRequests,
  JEV_MODEL,
  JevDecisionProvider,
} from "../interpret/jev.ts";
import { OpenRouterDecisionProvider } from "../interpret/openrouter.ts";
import { decisionSchema } from "../interpret/schema.ts";
import {
  OpenRouterScheduleExtractor,
  SCHEDULE_JSON_SCHEMA,
} from "../interpret/schedule.ts";
import type { ScheduleOutcome } from "../interpret/schedule.ts";
import { RELEASE_TIMING } from "../interpret/types.ts";
import type {
  DecisionOutcome,
  Excerpt,
  JevCrosscheck,
  JevGate,
  Question,
} from "../interpret/types.ts";
import type { DecisionProvider } from "../interpret/provider.ts";
import { parseCashFile } from "../plan/cash-file.ts";
import {
  buildTwinveeInputs,
  escrowRules,
  policyAdjustments,
  PlanError,
} from "../plan/twinvee.ts";
import type { TwinveeAssumptions } from "../plan/twinvee.ts";
import {
  CLIENT_COUNTER_SCHEMA,
  OpenRouterClientCounterExtractor,
} from "../interpret/client-counter.ts";
import type { ClientCitation, ClientCounterTexts } from "../interpret/client-counter.ts";
import { RECEIPT_VERSION } from "../review/receipt.ts";
import type { ClientReplyReceipt, IncrementalInfo, RunReceipt } from "../review/receipt.ts";
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
  CLIENT_REPLY_PROMPT_SUFFIX,
  clientReplyCallDigest,
  counterofferCallDigest,
  reverifyBestCandidate,
  runCounterofferSearch,
  testClientCandidate,
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

// Optional client reply letter. Fetched and versioned like the PDFs, but its
// sections stay out of the contract's section list (flags and human review
// only apply to the three contract files).
const REPLY_FILE_NAME = "04-client-reply.pdf";

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
  // The contract profile this run belongs to. Absent means twinvee — the
  // escrow path ignores it.
  contract?: string;
  // The run this one is based on. When its receipt carries digests, matching
  // typed calls reuse the previous outcomes instead of re-asking the model.
  previous?: { runId: string; receipt: RunReceipt; sourceTuple: SourceTuple };
  // Every run whose stored receipt passed all gates, newest first — the pool
  // each typed call may carry its answer from (per-call digest match).
  carrySources?: { runId: string; receipt: RunReceipt }[];
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
  typesafeConn?: Connection;
  all: Connection[];
};

type CarryKey =
  | "release_timing"
  | "escrow_schedule"
  | "counteroffer_search"
  | "schedule_crosscheck"
  | "client_letter_gate"
  | "client_counter"
  | "client_counter_crosscheck"
  | "client_reply_search";

// Finds the first carry source (newest first) whose stored digest for this
// typed call matches; the caller still checks the outcome is carryable.
type CarrySourceLookup = (
  key: CarryKey,
  digest: string,
) => { runId: string; receipt: RunReceipt } | undefined;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function connect(config: PipelineConfig, timer: StageTimer): Promise<Connectors> {
  const connections =
    config.connections ?? (await timer.step("gateway_list", listConnections()));
  const boxConn = connections.find((c) => c.provider === "box");
  const openrouterConn = connections.find((c) => c.provider === "openrouter");
  const typesafeConn = connections.find((c) => c.provider === "typesafe");
  if (boxConn === undefined) throw new PipelineError("box", new Error("box connector not configured"));
  if (openrouterConn === undefined) {
    throw new PipelineError("openrouter", new Error("openrouter connector not configured"));
  }
  return {
    boxConn,
    openrouterConn,
    ...(typesafeConn !== undefined ? { typesafeConn } : {}),
    all: connections,
  };
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

type OptionalFetched = FetchedFile & { fileId: string; versionId: string };

async function fetchSources(
  boxConn: Connection,
  folderName: string,
  timer: StageTimer,
): Promise<{
  sourceTuple: SourceTuple;
  fetched: FetchedFile[];
  cashFile: OptionalFetched | undefined;
  replyFile: OptionalFetched | undefined;
}> {
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
  const fetchOptional = async (
    name: string,
  ): Promise<OptionalFetched | undefined> => {
    const entry = entries.find((e) => e.type === "file" && e.name === name);
    if (entry === undefined) return undefined;
    const evidence = await timer.step(
      "box_fetch",
      fetchBoxFile(boxConn.gatewayBaseUrl, entry.id),
    );
    sourceTuple.push({
      fileName: evidence.metadata.name,
      fileId: entry.id,
      versionId: evidence.metadata.fileVersionId,
      sha256: evidence.sha256,
      size: evidence.metadata.size,
    });
    return {
      fileName: evidence.metadata.name,
      fileId: entry.id,
      versionId: evidence.metadata.fileVersionId,
      bytes: evidence.bytes,
      sha256: evidence.sha256,
      versionPresent: evidence.metadata.fileVersionId.length > 0,
    };
  };
  const cashFile = await fetchOptional(CASH_FILE_NAME);
  const replyFile = await fetchOptional(REPLY_FILE_NAME);
  return { sourceTuple, fetched, cashFile, replyFile };
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
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  added.sort(byCodeUnit);
  removed.sort(byCodeUnit);
  changed.sort(byCodeUnit);
  return { added, removed, changed };
}

async function loadAssumptions(fixturesDir: string): Promise<TwinveeAssumptions> {
  const raw = await readFile(`${fixturesDir}/plan/twinvee-demo-assumptions.json`, "utf8");
  try {
    return JSON.parse(raw) as TwinveeAssumptions;
  } catch (error) {
    throw new Error("plan/twinvee-demo-assumptions.json is not valid JSON", {
      cause: error,
    });
  }
}

// Connects through the gateway, fetches every evidence file and sectionizes
// the three contract PDFs. Any connector or Box failure aborts the run.
async function collectSources(
  config: PipelineConfig,
  timer: StageTimer,
): Promise<{
  connectors: Connectors;
  sourceTuple: SourceTuple;
  fetched: FetchedFile[];
  cashFile: OptionalFetched | undefined;
  replyFile: OptionalFetched | undefined;
  sections: ContractSection[];
  excerpts: Excerpt[];
}> {
  timer.begin();
  const connectors = await connect(config, timer);
  timer.record("gateway_list");

  // --- Evidence: fetch all three PDFs -------------------------------------------
  timer.begin();
  const folderName = config.boxFolder ?? "caveat_TEST";
  const { sourceTuple, fetched, cashFile, replyFile } = await fetchSources(connectors.boxConn, folderName, timer);
  timer.record("box_fetch");

  // --- PDF text -> sections ------------------------------------------------------
  timer.begin();
  const { sections, excerpts } = await sectionize(fetched, config.pdfText ?? extractPdfLines, timer);
  timer.record("sections");

  return { connectors, sourceTuple, fetched, cashFile, replyFile, sections, excerpts };
}

// sha256 of each contract section's text keyed by excerpt id — the
// clause-level diff baseline the next incremental run compares against —
// plus the reply letter's own excerpts when the letter is present.
async function buildEvidenceContext(
  sections: ContractSection[],
  replyFile: OptionalFetched | undefined,
  pdfText: NonNullable<PipelineConfig["pdfText"]>,
  timer: StageTimer,
): Promise<{ sectionDigests: Record<string, string>; replyExcerpts: Excerpt[] }> {
  const sectionDigests: Record<string, string> = {};
  for (const section of sections) {
    sectionDigests[`${section.fileName}#${section.sectionId}`] = createHash("sha256")
      .update(section.text)
      .digest("hex");
  }
  const replyExcerpts =
    replyFile === undefined
      ? []
      : await sectionizeReplyLetter(replyFile, pdfText, sectionDigests, timer);
  return { sectionDigests, replyExcerpts };
}

// The client reply letter (when present) is sectionized separately: its
// digests join sectionDigests under its own file name, but its sections
// stay out of the contract's sections/excerpts — flags and human review
// only apply to the contract PDFs.
async function sectionizeReplyLetter(
  replyFile: OptionalFetched,
  pdfText: NonNullable<PipelineConfig["pdfText"]>,
  sectionDigests: Record<string, string>,
  timer: StageTimer,
): Promise<Excerpt[]> {
  const pages = await timer.step("pdf_text", pdfText(replyFile.bytes));
  const replySections = extractSections(replyFile.fileName, pages);
  const versionLabel = `sha256 ${replyFile.sha256.slice(0, 12)}`;
  const replyExcerpts: Excerpt[] = [];
  for (const section of replySections) {
    sectionDigests[`${section.fileName}#${section.sectionId}`] = createHash("sha256")
      .update(section.text)
      .digest("hex");
    replyExcerpts.push({
      id: `${section.fileName}#${section.sectionId}`,
      text: section.text,
      source: {
        fileName: section.fileName,
        versionLabel,
        page: section.pages[0],
        section: section.sectionId,
      },
    });
  }
  return replyExcerpts;
}

// Digests of exactly what determines each typed call; a matching digest in a
// previous run's receipt means its outcome can be reused verbatim. Each digest
// covers the exact provider payload, so an OpenRouter answer can never be
// carried as a Jev one (and vice versa).
function computeCallDigests(args: {
  question: Question;
  decisionExcerpts: Excerpt[];
  replyExcerpts: Excerpt[];
  typesafeConn: Connection | undefined;
  model: string;
}): {
  decisionCallDigest: string;
  scheduleCallDigest: string;
  clientCounterDigest: string;
  clientGateDigest: string;
} {
  const { question, decisionExcerpts, replyExcerpts, typesafeConn, model } = args;
  // Digests of exactly what determines each typed call; a matching digest in
  // the previous run's receipt means its outcome can be reused verbatim.
  const excerptDigestInputs = decisionExcerpts.map((e) => ({ id: e.id, text: e.text }));
  // The digest covers the exact provider payload, so an OpenRouter answer can
  // never be carried as a Jev one (and vice versa).
  const decisionCallDigest =
    typesafeConn !== undefined
      ? digestValue(buildReleaseTimingDigestInput(question, JEV_MODEL))
      : digestValue({
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
  const clientCounterDigest =
    replyExcerpts.length === 0
      ? "none"
      : digestValue({
          schemaName: "client_counter",
          schema: CLIENT_COUNTER_SCHEMA,
          systemPrompt: DECISION_SYSTEM_PROMPT,
          model,
          questionId: "client_counter",
          excerpts: replyExcerpts.map((e) => ({ id: e.id, text: e.text })),
        });
  const clientGateDigest =
    typesafeConn === undefined || replyExcerpts.length === 0
      ? "none"
      : digestValue({
          provider: "typesafe",
          request: buildGateRequest(replyExcerpts, JEV_MODEL),
        });
  return { decisionCallDigest, scheduleCallDigest, clientCounterDigest, clientGateDigest };
}

// The model, the operative-file excerpts that drive every typed call, the
// release-timing question, and the digests of all four typed calls.
function prepareDecisionInputs(
  excerpts: Excerpt[],
  replyExcerpts: Excerpt[],
  typesafeConn: Connection | undefined,
  config: PipelineConfig,
): {
  model: string;
  decisionExcerpts: Excerpt[];
  question: Question;
  decisionCallDigest: string;
  scheduleCallDigest: string;
  clientCounterDigest: string;
  clientGateDigest: string;
} {
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
  const {
    decisionCallDigest,
    scheduleCallDigest,
    clientCounterDigest,
    clientGateDigest,
  } = computeCallDigests({
    question,
    decisionExcerpts,
    replyExcerpts,
    typesafeConn,
    model,
  });
  return {
    model,
    decisionExcerpts,
    question,
    decisionCallDigest,
    scheduleCallDigest,
    clientCounterDigest,
    clientGateDigest,
  };
}

// Builds the carry context: the baseline run for the incremental diff plus
// the pool of carry sources (newest first) each typed call may borrow from. A
// source lends only the calls whose digest matches — needs_review receipts
// are filtered out even when a caller passes them. Without an explicit pool
// the baseline is the only source, matching the old behavior.
function buildCarryContext(config: PipelineConfig): {
  previous: PipelineConfig["previous"];
  carrySourceFor: CarrySourceLookup;
  baselineOk: boolean;
} {
  const previous = config.previous;
  // The pool of carry sources, newest first; a source lends only the calls
  // whose digest matches — needs_review receipts are filtered out even when a
  // caller passes them. Without an explicit pool the baseline is the only
  // source, matching the old behavior.
  const carrySources = (
    config.carrySources ?? (config.previous !== undefined ? [config.previous] : [])
  ).filter(
    (s) =>
      s.receipt.status === "reviewable" && s.receipt.typedCallDigests !== undefined,
  );
  const carrySourceFor: CarrySourceLookup = (key, digest) =>
    carrySources.find((s) => s.receipt.typedCallDigests?.[key] === digest);
  // Only a run whose own receipt passed every gate may lend its answers; a
  // blocked answer is always re-asked, never carried.
  const baselineOk =
    previous !== undefined &&
    previous.receipt.status === "reviewable" &&
    previous.receipt.sectionDigests !== undefined &&
    previous.receipt.typedCallDigests !== undefined;
  return { previous, carrySourceFor, baselineOk };
}

// Ask (or carry) the two typed calls over the contract excerpts: the
// release-timing decision and the escrow-schedule extraction, plus Jev's
// per-release cross-check of the extracted schedule when a TypeSafe
// connection exists.
async function runTypedCalls(args: {
  decisionCallDigest: string;
  scheduleCallDigest: string;
  question: Question;
  decisionExcerpts: Excerpt[];
  openrouterConn: Connection;
  typesafeConn: Connection | undefined;
  model: string;
  carrySourceFor: CarrySourceLookup;
  reran: string[];
  carriedForward: string[];
  blockedReasons: { reason: string; detail: string }[];
  timer: StageTimer;
}): Promise<{
  decision: DecisionOutcome;
  schedule: ScheduleOutcome;
  scheduleCrosscheck: JevCrosscheck[] | undefined;
  scheduleCrosscheckDigest: string;
}> {
  const {
    decisionCallDigest,
    scheduleCallDigest,
    question,
    decisionExcerpts,
    openrouterConn,
    typesafeConn,
    model,
    carrySourceFor,
    reran,
    carriedForward,
    blockedReasons,
    timer,
  } = args;
  // --- Typed decision -------------------------------------------------------------
  timer.begin();
  const decisionSource = carrySourceFor("release_timing", decisionCallDigest);
  const prevDecision = decisionSource?.receipt.releaseTiming?.outcome;
  let decision: DecisionOutcome;
  if (prevDecision?.status === "decided" && decisionSource !== undefined) {
    decision = { ...prevDecision, carriedFrom: decisionSource.runId };
    carriedForward.push("release_timing");
  } else {
    const provider: DecisionProvider =
      typesafeConn !== undefined
        ? new JevDecisionProvider({
            gatewayBaseUrl: typesafeConn.gatewayBaseUrl,
          })
        : new OpenRouterDecisionProvider({
            gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
            model,
          });
    decision = await provider.decide(question);
    reran.push("release_timing");
  }
  timer.record("release_timing");

  // --- Typed extraction --------------------------------------------------------------
  timer.begin();
  const scheduleSource = carrySourceFor("escrow_schedule", scheduleCallDigest);
  const prevSchedule = scheduleSource?.receipt.schedule?.outcome;
  let schedule: ScheduleOutcome;
  if (prevSchedule?.status === "extracted" && scheduleSource !== undefined) {
    schedule = { ...prevSchedule, carriedFrom: scheduleSource.runId };
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

  // --- Jev schedule cross-check --------------------------------------------------
  // Jev verifies the extraction's conditional label on every release against
  // that release's own quote. Runs whenever the schedule is usable — carried
  // or fresh — and carries by its own digest like the other typed calls.
  let scheduleCrosscheck: JevCrosscheck[] | undefined;
  let scheduleCrosscheckDigest = "none";
  if (typesafeConn !== undefined && schedule.status === "extracted") {
    timer.begin();
    const crosscheckDigest = digestValue({
      provider: "typesafe",
      requests: buildScheduleCrosscheckRequests(schedule.schedule.releases, JEV_MODEL),
    });
    scheduleCrosscheckDigest = crosscheckDigest;
    const crosscheckSource = carrySourceFor("schedule_crosscheck", crosscheckDigest);
    const prevCrosscheck = crosscheckSource?.receipt.schedule?.crosscheck;
    if (prevCrosscheck !== undefined && prevCrosscheck.length > 0) {
      scheduleCrosscheck = prevCrosscheck;
      carriedForward.push("schedule_crosscheck");
    } else {
      const jev = new JevDecisionProvider({
        gatewayBaseUrl: typesafeConn.gatewayBaseUrl,
      });
      const outcome = await jev.crosscheckSchedule(schedule.schedule.releases);
      reran.push("schedule_crosscheck");
      if (outcome.status === "pass") {
        scheduleCrosscheck = outcome.checks;
      } else if (outcome.status === "failed") {
        blockedReasons.push({ reason: outcome.reason, detail: outcome.detail });
      } else {
        scheduleCrosscheck = outcome.checks;
        blockedReasons.push({
          reason:
            outcome.status === "mismatch" ? "jev_crosscheck_mismatch" : "low_confidence",
          detail: outcome.detail,
        });
      }
    }
    timer.record("schedule_crosscheck");
  }
  return { decision, schedule, scheduleCrosscheck, scheduleCrosscheckDigest };
}

// Flags, human-review artifacts, gate evaluation, the owner cash file, the
// deterministic runner readings and the compiled search base + its call
// digest. Mutates blockedReasons like the surrounding stages.
async function runRunnerStage(args: {
  sections: ContractSection[];
  decision: DecisionOutcome;
  schedule: ScheduleOutcome;
  cashFile: OptionalFetched | undefined;
  model: string;
  config: PipelineConfig;
  blockedReasons: { reason: string; detail: string }[];
  timer: StageTimer;
}): Promise<{
  flags: ReturnType<typeof detectFlags>;
  humanReview: RunReceipt["humanReview"];
  overrides: SourcedOverride[];
  effectiveAction: string | null;
  assumptions: TwinveeAssumptions;
  cashSource: NonNullable<RunReceipt["cashSource"]>;
  expectedCheck: RunReceipt["expectedCheck"];
  readings: RunReceipt["readings"];
  prepared: { base: SearchBase; searchReadings: SearchReading[] } | undefined;
  searchCallDigest: string;
}> {
  const {
    sections,
    decision,
    schedule,
    cashFile,
    model,
    config,
    blockedReasons,
    timer,
  } = args;
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
  return {
    flags,
    humanReview,
    overrides,
    effectiveAction,
    assumptions,
    cashSource,
    expectedCheck,
    readings,
    prepared,
    searchCallDigest,
  };
}

// Carry-or-run for the counteroffer search: a digest match in a reviewable
// source reuses the outcome (carrySearch re-verifies a "found" best on a
// worker); anything else runs the model-driven search. Worker and model
// failures degrade to a needs_review receipt instead of throwing. Skipped
// entirely when an earlier blocker exists or the inputs are missing.
async function runCounterofferStage(args: {
  prepared: { base: SearchBase; searchReadings: SearchReading[] } | undefined;
  schedule: ScheduleOutcome;
  searchCallDigest: string;
  connectors: Connectors;
  model: string;
  config: PipelineConfig;
  carrySourceFor: CarrySourceLookup;
  reran: string[];
  carriedForward: string[];
  blockedReasons: { reason: string; detail: string }[];
  timer: StageTimer;
}): Promise<CounterofferReceipt | undefined> {
  const {
    prepared,
    schedule,
    searchCallDigest,
    connectors,
    model,
    config,
    carrySourceFor,
    reran,
    carriedForward,
    blockedReasons,
    timer,
  } = args;
  if (
    blockedReasons.length !== 0 ||
    prepared === undefined ||
    schedule.status !== "extracted"
  ) {
    return undefined;
  }
  timer.begin();
  const counteroffer = await runCounterofferStageBody({
    prepared,
    schedule,
    searchCallDigest,
    connectors,
    model,
    config,
    carrySourceFor,
    reran,
    carriedForward,
  });
  if (counteroffer.status === "needs_review") {
    blockedReasons.push({
      reason: counteroffer.reason ?? "counteroffer_needs_review",
      detail: counteroffer.detail ?? `counteroffer search stopped: ${counteroffer.stopReason}`,
    });
  }
  timer.record("counteroffer");
  return counteroffer;
}

async function runCounterofferStageBody(args: {
  prepared: { base: SearchBase; searchReadings: SearchReading[] };
  schedule: Extract<ScheduleOutcome, { status: "extracted" }>;
  searchCallDigest: string;
  connectors: Connectors;
  model: string;
  config: PipelineConfig;
  carrySourceFor: CarrySourceLookup;
  reran: string[];
  carriedForward: string[];
}): Promise<CounterofferReceipt> {
  const {
    prepared,
    schedule,
    searchCallDigest,
    connectors,
    model,
    config,
    carrySourceFor,
    reran,
    carriedForward,
  } = args;
  try {
    const searchSource = carrySourceFor("counteroffer_search", searchCallDigest);
    const prevSearch = searchSource?.receipt.counteroffer;
    const canCarry =
      searchSource !== undefined &&
      prevSearch !== undefined &&
      (prevSearch.status === "found" ||
        prevSearch.status === "not_found" ||
        prevSearch.status === "not_needed");
    if (canCarry && prevSearch !== undefined && searchSource !== undefined) {
      const carried = await carrySearch(
        { runId: searchSource.runId, receipt: searchSource.receipt },
        prevSearch,
        prepared,
        connectors,
        model,
        config,
      );
      if (carried.carried) carriedForward.push("counteroffer_search");
      return carried.receipt;
    }
    const fresh = await runSearchStage(schedule, prepared, connectors, model, config);
    reran.push("counteroffer_search");
    return fresh;
  } catch (error) {
    return {
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
}

// Builds the stored receipt — every field below is receipt JSON, so field
// order and presence must stay byte-stable.
function assembleReceipt(args: {
  config: PipelineConfig;
  previous: PipelineConfig["previous"];
  baselineOk: boolean;
  sourceTuple: SourceTuple;
  fetched: FetchedFile[];
  cashFile: OptionalFetched | undefined;
  replyFile: OptionalFetched | undefined;
  sections: ContractSection[];
  sectionDigests: Record<string, string>;
  digests: {
    decisionCallDigest: string;
    scheduleCallDigest: string;
    searchCallDigest: string;
    scheduleCrosscheckDigest: string;
    clientGateDigest: string;
    clientCounterDigest: string;
    clientCounterCrosscheckDigest: string;
    clientReplySearchDigest: string;
  };
  blockedReasons: { reason: string; detail: string }[];
  reran: string[];
  carriedForward: string[];
  decision: DecisionOutcome;
  question: Question;
  effectiveAction: string | null;
  overrides: SourcedOverride[];
  schedule: ScheduleOutcome;
  scheduleCrosscheck: JevCrosscheck[] | undefined;
  decisionExcerpts: Excerpt[];
  humanReview: RunReceipt["humanReview"];
  flags: ReturnType<typeof detectFlags>;
  readings: RunReceipt["readings"];
  assumptions: TwinveeAssumptions;
  cashSource: NonNullable<RunReceipt["cashSource"]>;
  expectedCheck: RunReceipt["expectedCheck"];
  counteroffer: CounterofferReceipt | undefined;
  clientReply: ClientReplyReceipt | undefined;
}): RunReceipt {
  const {
    config,
    previous,
    baselineOk,
    sourceTuple,
    fetched,
    cashFile,
    replyFile,
    sections,
    sectionDigests,
    digests,
    blockedReasons,
    reran,
    carriedForward,
    decision,
    question,
    effectiveAction,
    overrides,
    schedule,
    scheduleCrosscheck,
    decisionExcerpts,
    humanReview,
    flags,
    readings,
    assumptions,
    cashSource,
    expectedCheck,
    counteroffer,
    clientReply,
  } = args;
  const {
    decisionCallDigest,
    scheduleCallDigest,
    searchCallDigest,
    scheduleCrosscheckDigest,
    clientGateDigest,
    clientCounterDigest,
    clientCounterCrosscheckDigest,
    clientReplySearchDigest,
  } = digests;
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
      ...(replyFile !== undefined
        ? [
            {
              fileName: replyFile.fileName,
              versionLabel: `sha256 ${replyFile.sha256.slice(0, 12)}`,
              versionPresent: replyFile.versionPresent,
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
      // Only present when a reply letter was processed — runs without one stay
      // byte-identical to runs predating the reply feature.
      ...(clientGateDigest !== "none"
        ? { client_letter_gate: clientGateDigest }
        : {}),
      ...(scheduleCrosscheckDigest !== "none"
        ? { schedule_crosscheck: scheduleCrosscheckDigest }
        : {}),
      ...(clientCounterDigest !== "none"
        ? { client_counter: clientCounterDigest }
        : {}),
      ...(clientCounterCrosscheckDigest !== "none"
        ? { client_counter_crosscheck: clientCounterCrosscheckDigest }
        : {}),
      ...(clientReplySearchDigest !== "none"
        ? { client_reply_search: clientReplySearchDigest }
        : {}),
    },
    releaseTiming: { outcome: decision, question },
    effectiveAction,
    overrides,
    schedule: {
      outcome: schedule,
      excerpts: decisionExcerpts,
      ...(scheduleCrosscheck !== undefined ? { crosscheck: scheduleCrosscheck } : {}),
    },
    humanReview,
    flags,
    readings,
    assumptions,
    ...(counteroffer !== undefined ? { counteroffer } : {}),
    ...(clientReply !== undefined ? { clientReply } : {}),
    ...(incremental !== undefined ? { incremental } : {}),
  };
  return receipt;
}

// The client-reply stage: Jev letter gate (TypeSafe connection only) ->
// verbatim counter read -> every-worker runner test -> seeded follow-up
// search when the counter fails. Runs only after the main search and only
// with no earlier blockers; mutates the pipeline's reran / carriedForward /
// blockedReasons lists like the rest of the stages.
async function runReplyStage(args: {
  replyFile: OptionalFetched | undefined;
  replyExcerpts: Excerpt[];
  prepared: { base: SearchBase; searchReadings: SearchReading[] } | undefined;
  schedule: ScheduleOutcome;
  connectors: Connectors;
  model: string;
  config: PipelineConfig;
  clientGateDigest: string;
  clientCounterDigest: string;
  carrySourceFor: CarrySourceLookup;
  reran: string[];
  carriedForward: string[];
  blockedReasons: { reason: string; detail: string }[];
  timer: StageTimer;
}): Promise<{
  clientReply: ClientReplyReceipt | undefined;
  clientReplySearchDigest: string;
  clientCounterCrosscheckDigest: string;
}> {
  const {
    replyFile,
    replyExcerpts,
    prepared,
    schedule,
    connectors,
    model,
    config,
    clientGateDigest,
    clientCounterDigest,
    carrySourceFor,
    reran,
    carriedForward,
    blockedReasons,
    timer,
  } = args;
  const { openrouterConn, typesafeConn } = connectors;
  if (
    replyFile === undefined ||
    replyExcerpts.length === 0 ||
    prepared === undefined ||
    schedule.status !== "extracted" ||
    blockedReasons.length !== 0
  ) {
    return {
      clientReply: undefined,
      clientReplySearchDigest: "none",
      clientCounterCrosscheckDigest: "none",
    };
  }

  timer.begin();
  let clientReply: ClientReplyReceipt | undefined;
  let clientReplySearchDigest = "none";
  let clientCounterCrosscheckDigest = "none";

  const replyFileMeta = {
    fileName: replyFile.fileName,
    versionTag: versionTag({
      fileId: replyFile.fileId,
      versionId: replyFile.versionId,
    }),
    sha12: sha12(replyFile.sha256),
  };
  const conditionalReleases = schedule.schedule.releases
    .filter((r) => r.extensionId !== undefined)
    .map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      date: r.date,
      extensionId: r.extensionId as string,
    }));

  // The typed read carries by call digest like the other typed calls; the
  // deterministic worker test always re-runs (it covers base + readings,
  // which the read digest does not).
  let counterRecord: SearchCandidateRecord | undefined;
  let counterTexts: ClientCounterTexts | undefined;
  let counterCrosscheck: JevCrosscheck | undefined;
  let citation: ClientCitation | undefined;
  let workers: string[] | undefined;
  let replyFail: { reason: string; detail: string } | undefined;

  // Jev letter gate (TypeSafe connection only): the letter must propose
  // exactly one payment change before any OpenRouter extraction runs. A
  // failing gate makes no model call beyond the gate itself.
  let gate: JevGate | undefined;
  if (typesafeConn !== undefined) {
    const gateSource = carrySourceFor("client_letter_gate", clientGateDigest);
    const carriedGate = gateSource?.receipt.clientReply?.gate;
    if (carriedGate !== undefined) {
      gate = carriedGate;
      carriedForward.push("client_letter_gate");
    } else {
      const jev = new JevDecisionProvider({
        gatewayBaseUrl: typesafeConn.gatewayBaseUrl,
      });
      const g = await jev.gateLetter(replyExcerpts);
      reran.push("client_letter_gate");
      if (g.status === "pass") {
        gate = g.gate;
      } else {
        if (g.status !== "failed") gate = g.gate;
        replyFail =
          g.status === "not_single"
            ? {
                reason: "counter_not_single_change",
                detail: `Jev decided the letter does not propose exactly one payment change (p = ${g.gate.noul.toFixed(2)})`,
              }
            : g.status === "uncertain"
              ? {
                  reason: "low_confidence",
                  detail: `Jev could not decide whether the letter proposes exactly one payment change (p = ${g.gate.noul.toFixed(2)})`,
                }
              : { reason: g.reason, detail: g.detail };
      }
    }
  }

  const counterSource =
    replyFail === undefined
      ? carrySourceFor("client_counter", clientCounterDigest)
      : undefined;
  const prevReply = counterSource?.receipt.clientReply;
  // With a TypeSafe connection the cross-check needs the extraction's
  // verbatim texts; a carried counter from a receipt that lacks them is
  // re-extracted so the cross-check can restate it exactly.
  const carryRead =
    replyFail === undefined &&
    counterSource !== undefined &&
    prevReply?.counter !== undefined &&
    prevReply.citation !== undefined &&
    (typesafeConn === undefined || prevReply.counterTexts !== undefined);
  if (carryRead && prevReply !== undefined && prevReply.counter !== undefined) {
    const carried = prevReply.counter;
    counterRecord = {
      id: carried.id,
      lever: carried.lever,
      params: carried.params,
      rationale: carried.rationale,
      status: "tested",
    };
    citation = prevReply.citation;
    counterTexts = typesafeConn !== undefined ? prevReply.counterTexts : undefined;
    carriedForward.push("client_counter");
  } else if (replyFail === undefined) {
    const extractor = new OpenRouterClientCounterExtractor({
      gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
      model,
    });
    const read = await extractor.extract({
      id: "client_counter",
      excerpts: replyExcerpts,
    });
    if (read.status === "needs_review") {
      replyFail = { reason: read.reason, detail: read.detail };
    } else {
      citation = read.citation;
      counterTexts = typesafeConn !== undefined ? read.texts : undefined;
      counterRecord = {
        id: "client",
        lever: read.candidate.lever,
        params: {
          amount_cents: read.candidate.amount_cents,
          date: read.candidate.date,
          split_count: read.candidate.split_count,
          net_days: read.candidate.net_days,
        },
        rationale: read.candidate.rationale,
        status: "tested",
      };
    }
    reran.push("client_counter");
  }

  // Jev counter cross-check: Jev must agree that the cited sentence proposes
  // the extracted change before the runner spends a worker round on it.
  if (
    typesafeConn !== undefined &&
    replyFail === undefined &&
    counterRecord !== undefined &&
    citation !== undefined &&
    counterTexts !== undefined
  ) {
    const crosscheckRequest = buildCounterCrosscheckRequest(
      counterRecord.lever,
      counterTexts,
      citation.quote,
      JEV_MODEL,
    );
    if (crosscheckRequest === undefined) {
      replyFail = {
        reason: "schema_mismatch",
        detail: "the extracted counter texts cannot build the cross-check instruction",
      };
    } else {
      clientCounterCrosscheckDigest = digestValue({
        provider: "typesafe",
        request: crosscheckRequest,
      });
      const crosscheckSource = carrySourceFor(
        "client_counter_crosscheck",
        clientCounterCrosscheckDigest,
      );
      const prevCheck = crosscheckSource?.receipt.clientReply?.counterCrosscheck;
      if (prevCheck !== undefined) {
        counterCrosscheck = prevCheck;
        carriedForward.push("client_counter_crosscheck");
      } else {
        const jev = new JevDecisionProvider({
          gatewayBaseUrl: typesafeConn.gatewayBaseUrl,
        });
        const outcome = await jev.crosscheckCounter({
          lever: counterRecord.lever,
          texts: counterTexts,
          quote: citation.quote,
        });
        reran.push("client_counter_crosscheck");
        if (outcome.status === "pass") {
          counterCrosscheck = outcome.checks[0];
        } else if (outcome.status === "failed") {
          replyFail = { reason: outcome.reason, detail: outcome.detail };
        } else {
          counterCrosscheck = outcome.checks[0];
          replyFail = {
            reason:
              outcome.status === "mismatch"
                ? "jev_crosscheck_mismatch"
                : "low_confidence",
            detail: outcome.detail,
          };
        }
      }
    }
  }

  if (replyFail === undefined && counterRecord !== undefined) {
    const resolved = resolvePool(connectors, model, config);
    if (!resolved.ok) {
      replyFail = {
        reason: "workers_unavailable",
        detail: resolved.receipt.detail ?? "no worker pool available",
      };
    } else {
      const tested = await testClientCandidate({
        base: prepared.base,
        readings: prepared.searchReadings,
        record: counterRecord,
        pool: resolved.pool,
      });
      if (!tested.ok) {
        replyFail = { reason: tested.reason, detail: tested.detail };
      } else {
        counterRecord = tested.record;
        workers = tested.workers;
      }
    }
  }

  if (replyFail !== undefined) {
    clientReply = {
      status: "needs_review",
      ...replyFileMeta,
      reason: replyFail.reason,
      detail: replyFail.detail,
      ...(gate !== undefined ? { gate } : {}),
      ...(citation !== undefined ? { citation } : {}),
      ...(counterTexts !== undefined ? { counterTexts } : {}),
      ...(counterCrosscheck !== undefined ? { counterCrosscheck } : {}),
      ...(counterRecord !== undefined ? { counter: counterRecord } : {}),
      ...(workers !== undefined ? { workers } : {}),
    };
    blockedReasons.push({ reason: replyFail.reason, detail: replyFail.detail });
  } else if (counterRecord !== undefined && citation !== undefined) {
    const counterFields = {
      ...replyFileMeta,
      citation,
      ...(counterTexts !== undefined ? { counterTexts } : {}),
      counter: counterRecord,
      ...(workers !== undefined ? { workers } : {}),
      ...(gate !== undefined ? { gate } : {}),
      ...(counterCrosscheck !== undefined ? { counterCrosscheck } : {}),
    };
    if (counterRecord.passesAll === true) {
      clientReply = { status: "safe", ...counterFields };
    } else {
      // The client's counter fails: find the smallest tested change that
      // passes, seeded with the client's record and its failing brackets.
      clientReplySearchDigest = clientReplyCallDigest({
        base: prepared.base,
        readings: prepared.searchReadings,
        seed: counterRecord,
        model,
        systemPromptSuffix: CLIENT_REPLY_PROMPT_SUFFIX,
      });
      let response: CounterofferReceipt;
      const replySource = carrySourceFor(
        "client_reply_search",
        clientReplySearchDigest,
      );
      const prevResponse = replySource?.receipt.clientReply?.response;
      const canCarry =
        replySource !== undefined &&
        prevResponse !== undefined &&
        (prevResponse.status === "found" || prevResponse.status === "not_found");
      if (canCarry && prevResponse !== undefined && replySource !== undefined) {
        const carried = await carrySearch(
          { runId: replySource.runId, receipt: replySource.receipt },
          prevResponse,
          prepared,
          connectors,
          model,
          config,
        );
        response = carried.receipt;
        if (carried.carried) carriedForward.push("client_reply_search");
        else reran.push("client_reply_search");
      } else {
        const resolved = resolvePool(connectors, model, config);
        if (!resolved.ok) {
          response = resolved.receipt;
        } else {
          response = await runCounterofferSearch({
            base: prepared.base,
            readings: prepared.searchReadings,
            model,
            chatConfig: chatConfig(
              connectors.openrouterConn.gatewayBaseUrl,
              searchTimeoutMs(),
              undefined,
              fetch,
            ),
            pool: resolved.pool,
            ...(config.chat !== undefined ? { chat: config.chat } : {}),
            conditionalReleases,
            seedRecords: [counterRecord],
            idPrefix: "reply-",
            systemPromptSuffix: CLIENT_REPLY_PROMPT_SUFFIX,
          });
        }
        reran.push("client_reply_search");
      }
      if (response.status === "found") {
        clientReply = { status: "countered", ...counterFields, response };
      } else if (response.status === "not_found") {
        clientReply = { status: "no_fix", ...counterFields, response };
        blockedReasons.push({
          reason: "client_counter_no_fix",
          detail:
            "the client's proposed change fails and the follow-up search found no tested change that keeps cash at or above the floor",
        });
      } else {
        const reason = response.reason ?? "client_reply_needs_review";
        const detail =
          response.detail ?? `client reply search stopped: ${response.stopReason}`;
        clientReply = {
          status: "needs_review",
          ...counterFields,
          reason,
          detail,
          response,
        };
        blockedReasons.push({ reason, detail });
      }
    }
  }

  timer.record("client_reply");
  return { clientReply, clientReplySearchDigest, clientCounterCrosscheckDigest };
}

// The evidence->decision->runner pipeline. The typed questions cover the
// operative (second) amendment; the other files' sections feed flags and
// human-review citation verification.
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const timer = new StageTimer();
  const blockedReasons: { reason: string; detail: string }[] = [];

  // --- Connectors -------------------------------------------------------------
  const {
    connectors,
    sourceTuple,
    fetched,
    cashFile,
    replyFile,
    sections,
    excerpts,
  } = await collectSources(config, timer);
  const { openrouterConn, typesafeConn } = connectors;
  const { sectionDigests, replyExcerpts } = await buildEvidenceContext(
    sections,
    replyFile,
    config.pdfText ?? extractPdfLines,
    timer,
  );
  const {
    model,
    decisionExcerpts,
    question,
    decisionCallDigest,
    scheduleCallDigest,
    clientCounterDigest,
    clientGateDigest,
  } = prepareDecisionInputs(excerpts, replyExcerpts, typesafeConn, config);
  const { previous, carrySourceFor, baselineOk } = buildCarryContext(config);
  const reran: string[] = [];
  const carriedForward: string[] = [];

  const { decision, schedule, scheduleCrosscheck, scheduleCrosscheckDigest } =
    await runTypedCalls({
      decisionCallDigest,
      scheduleCallDigest,
      question,
      decisionExcerpts,
      openrouterConn,
      typesafeConn,
      model,
      carrySourceFor,
      reran,
      carriedForward,
      blockedReasons,
      timer,
    });

  const {
    flags,
    humanReview,
    overrides,
    effectiveAction,
    assumptions,
    cashSource,
    expectedCheck,
    readings,
    prepared,
    searchCallDigest,
  } = await runRunnerStage({
    sections,
    decision,
    schedule,
    cashFile,
    model,
    config,
    blockedReasons,
    timer,
  });
  const counteroffer = await runCounterofferStage({
    prepared,
    schedule,
    searchCallDigest,
    connectors,
    model,
    config,
    carrySourceFor,
    reran,
    carriedForward,
    blockedReasons,
    timer,
  });
  const replyStage = await runReplyStage({
    replyFile,
    replyExcerpts,
    prepared,
    schedule,
    connectors,
    model,
    config,
    clientGateDigest,
    clientCounterDigest,
    carrySourceFor,
    reran,
    carriedForward,
    blockedReasons,
    timer,
  });
  const clientReply = replyStage.clientReply;
  const clientReplySearchDigest = replyStage.clientReplySearchDigest;
  const clientCounterCrosscheckDigest = replyStage.clientCounterCrosscheckDigest;
  timer.finish();

  const receipt = assembleReceipt({
    config,
    previous,
    baselineOk,
    sourceTuple,
    fetched,
    cashFile,
    replyFile,
    sections,
    sectionDigests,
    digests: {
      decisionCallDigest,
      scheduleCallDigest,
      searchCallDigest,
      scheduleCrosscheckDigest,
      clientGateDigest,
      clientCounterDigest,
      clientCounterCrosscheckDigest,
      clientReplySearchDigest,
    },
    blockedReasons,
    reran,
    carriedForward,
    decision,
    question,
    effectiveAction,
    overrides,
    schedule,
    scheduleCrosscheck,
    decisionExcerpts,
    humanReview,
    flags,
    readings,
    assumptions,
    cashSource,
    expectedCheck,
    counteroffer,
    clientReply,
  });


  return { receipt, sourceTuple, sections, timingsMs: timer.timings };
}
