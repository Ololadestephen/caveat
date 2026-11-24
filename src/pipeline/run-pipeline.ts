import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

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
import { buildTwinveeInputs, policyAdjustments, PlanError } from "../plan/twinvee.ts";
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
  retainer_superseded: "runner/twinvee-escrow.expected.json",
  retainer_continues: "runner/twinvee-escrow-retainer-continues.expected.json",
};

const READING_LABELS: Record<string, string> = {
  retainer_superseded: "Retainer superseded",
  retainer_continues: "Retainer continues",
};

export type Connection = { provider: string; gatewayBaseUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listConnections(options: { fetch?: typeof fetch } = {}): Promise<
  Connection[]
> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(GATEWAY_LIST_URL);
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

// The evidence->decision->runner pipeline. The typed questions cover the
// operative (second) amendment; the other files' sections feed flags and
// human-review citation verification. Results are compared against the
// committed expected fixtures unless assertExpected is false — a mismatch
// blocks the run rather than shipping wrong numbers.
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const timings: Record<string, number> = {};
  const totalStarted = performance.now();
  const timed = <T>(step: string, started: number, value: T): T => {
    timings[step] = Math.round(performance.now() - started);
    return value;
  };
  const at = (step: string) => async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (error) {
      throw new PipelineError(step, error);
    }
  };

  // --- Connectors -------------------------------------------------------------
  let started = performance.now();
  const connections =
    config.connections ?? (await at("gateway_list")(listConnections()));
  const boxConn = connections.find((c) => c.provider === "box");
  const openrouterConn = connections.find((c) => c.provider === "openrouter");
  if (boxConn === undefined) throw new PipelineError("box", new Error("box connector not configured"));
  if (openrouterConn === undefined) {
    throw new PipelineError("openrouter", new Error("openrouter connector not configured"));
  }
  timed("gateway_list", started, null);

  // --- Evidence: fetch all three PDFs -------------------------------------------
  started = performance.now();
  const folderName = config.boxFolder ?? "caveat_TEST";
  const folder = await at("box_folder")(
    findFolderByName(boxConn.gatewayBaseUrl, "0", folderName),
  );
  if (folder === undefined) {
    throw new PipelineError("box_folder", new Error(`folder ${folderName} not found`));
  }
  const entries = await at("box_list")(listFolder(boxConn.gatewayBaseUrl, folder.id));
  const sourceTuple: SourceTuple = [];
  const fetched: { fileName: string; bytes: Uint8Array; sha256: string; versionPresent: boolean }[] = [];
  for (const fileName of FILE_NAMES) {
    const entry = entries.find((e) => e.type === "file" && e.name === fileName);
    if (entry === undefined) {
      throw new PipelineError("box_file", new Error(`${fileName} not in ${folderName}`));
    }
    const evidence = await at("box_fetch")(fetchBoxFile(boxConn.gatewayBaseUrl, entry.id));
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
  timed("box_fetch", started, null);

  // --- PDF text -> sections ------------------------------------------------------
  started = performance.now();
  const sections: ContractSection[] = [];
  const excerpts: Excerpt[] = [];
  for (const file of fetched) {
    const pages = await at("pdf_text")(extractPdfLines(file.bytes));
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
  timed("sections", started, null);

  const blockedReasons: { reason: string; detail: string }[] = [];
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
  started = performance.now();
  const provider = new OpenRouterDecisionProvider({
    gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
    model,
  });
  const decision: DecisionOutcome = await provider.decide(question);
  timed("release_timing", started, null);

  // --- Typed extraction --------------------------------------------------------------
  started = performance.now();
  const extractor = new OpenRouterScheduleExtractor({
    gatewayBaseUrl: openrouterConn.gatewayBaseUrl,
    model,
  });
  const schedule: ScheduleOutcome = await extractor.extract({
    id: "escrow_schedule",
    excerpts: decisionExcerpts,
  });
  timed("schedule", started, null);

  // --- Flags --------------------------------------------------------------------------
  started = performance.now();
  const flags = detectFlags(sections);
  timed("flags", started, null);

  // --- Human review --------------------------------------------------------------------
  started = performance.now();
  let humanReview: RunReceipt["humanReview"];
  let review: RetainerReview | undefined;
  try {
    const raw: unknown = JSON.parse(
      await readFile(`${config.reviewsDir}/retainer-review.json`, "utf8"),
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
      await readFile(`${config.reviewsDir}/release-timing-override.json`, "utf8"),
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

  // --- Effective action -----------------------------------------------------------------
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

  // --- Assumptions + runner inputs ------------------------------------------------------
  started = performance.now();
  const assumptions = (await at("assumptions")(
    readFile(`${config.fixturesDir}/plan/twinvee-demo-assumptions.json`, "utf8").then(
      (t) => JSON.parse(t) as unknown,
    ),
  )) as TwinveeAssumptions;

  const readings: RunReceipt["readings"] = [];
  const canRun =
    schedule.status === "extracted" &&
    review !== undefined &&
    effectiveAction === "escrow_release";
  if (canRun && schedule.status === "extracted" && review !== undefined) {
    try {
      const inputs = buildTwinveeInputs({ schedule: schedule.schedule, review, assumptions });
      for (const [id, rawInput] of Object.entries(inputs)) {
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
  };

  return { receipt, sourceTuple, sections, timingsMs: timings };
}
