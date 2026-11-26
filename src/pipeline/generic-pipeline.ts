// The generic payment-terms path: extract every cash-timing term verbatim,
// cross-check each term with Jev, require reviewer confirmation, then model
// the two unresolved partial-month readings on both workers.
import { readFile } from "node:fs/promises";

import { contractProfile, DEFAULT_CONTRACT } from "../contracts/profiles.ts";
import type { ContractProfile } from "../contracts/profiles.ts";
import { findFolderByName, listFolder, fetchBoxFile } from "../evidence/box.ts";
import { detectFlags } from "../evidence/flags.ts";
import { extractPdfLines } from "../evidence/pdf-text.ts";
import { diffFiles, diffSectionDigests, PipelineError } from "./run-pipeline.ts";
import type { PipelineConfig, PipelineResult } from "./run-pipeline.ts";
import { extractSections } from "../evidence/sections.ts";
import type { ContractSection } from "../evidence/sections.ts";
import { sha12, versionTag } from "../evidence/recheck.ts";
import type { SourceTuple } from "../evidence/recheck.ts";
import { listConnections } from "../gateway.ts";
import type { Connection } from "../gateway.ts";
import { JevDecisionProvider, JEV_MODEL, buildTermClauseDigestInput, buildTermCrosscheckRequests } from "../interpret/jev.ts";
import { OpenRouterPaymentTermsExtractor, TERM_BOUNDS_JSON_SCHEMA } from "../interpret/payment-terms.ts";
import type { PaymentTermsOutcome, ValidatedPaymentTerms } from "../interpret/payment-terms.ts";
import { DECISION_SYSTEM_PROMPT } from "../interpret/prompt.ts";
import { PAYMENT_TERMS_JSON_SCHEMA } from "../interpret/payment-terms.ts";
import type { Excerpt, JevCrosscheck } from "../interpret/types.ts";
import { parseTermsCashFile } from "../plan/cash-file.ts";
import { policyAdjustments } from "../plan/twinvee.ts";
import {
  TERMS_READING_LABELS,
  buildTermsReadings,
  firstPaymentDate,
} from "../plan/terms.ts";
import type { TermsAssumptions } from "../plan/terms.ts";
import { RunInputError, validateRunInput } from "../runner/validate.ts";
import { digestValue } from "../runner/digest.ts";
import { RUNNER_VERSION, runFixture } from "../runner/run.ts";
import { RECEIPT_VERSION } from "../review/receipt.ts";
import type { RunReceipt } from "../review/receipt.ts";
import type { IncrementalInfo, ReceiptReading } from "../review/receipt.ts";
import { validateTermsReview } from "../review/terms-review.ts";
import type { TermsReviewCheck } from "../review/terms-review.ts";
import { SpritesHttpPool, WorkerUnavailableError } from "../worker/pool.ts";
import type { WorkerJob, WorkerPool } from "../worker/pool.ts";
import type { WorkerJobResult } from "../worker/pool.ts";

type Connectors = {
  boxConn: Connection;
  openrouterConn: Connection;
  typesafeConn?: Connection;
  all: Connection[];
};

type FetchedFile = {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  versionPresent: boolean;
};

type OptionalFetched = FetchedFile & { fileId: string; versionId: string };

const DEFAULT_WORKERS = "caveat-wa,caveat-wb";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function connectGeneric(config: PipelineConfig): Promise<Connectors> {
  const connections = config.connections ?? (await listConnections());
  const boxConn = connections.find((c) => c.provider === "box");
  const openrouterConn = connections.find((c) => c.provider === "openrouter");
  const typesafeConn = connections.find((c) => c.provider === "typesafe");
  if (boxConn === undefined) {
    throw new PipelineError("box", new Error("box connector not configured"));
  }
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

// Fetches the profile's required PDFs plus the optional cash and reply files.
async function fetchSources(
  boxConn: Connection,
  profile: ContractProfile,
  folderName: string,
): Promise<{
  sourceTuple: SourceTuple;
  fetched: FetchedFile[];
  cashFile: OptionalFetched | undefined;
  replyFile: OptionalFetched | undefined;
}> {
  const folder = await findFolderByName(boxConn.gatewayBaseUrl, "0", folderName);
  if (folder === undefined) {
    throw new PipelineError("box_folder", new Error(`folder ${folderName} not found`));
  }
  const entries = await listFolder(boxConn.gatewayBaseUrl, folder.id);
  const sourceTuple: SourceTuple = [];
  const fetched: FetchedFile[] = [];
  for (const fileName of profile.fileNames) {
    const entry = entries.find((e) => e.type === "file" && e.name === fileName);
    if (entry === undefined) {
      throw new PipelineError("box_file", new Error(`${fileName} not in ${folderName}`));
    }
    const evidence = await fetchBoxFile(boxConn.gatewayBaseUrl, entry.id);
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
    name: string | undefined,
  ): Promise<OptionalFetched | undefined> => {
    if (name === undefined) return undefined;
    const entry = entries.find((e) => e.type === "file" && e.name === name);
    if (entry === undefined) return undefined;
    const evidence = await fetchBoxFile(boxConn.gatewayBaseUrl, entry.id);
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
  const cashFile = await fetchOptional(profile.cashFileName);
  const replyFile = await fetchOptional(profile.replyFileName);
  return { sourceTuple, fetched, cashFile, replyFile };
}

function sectionize(
  fetched: FetchedFile[],
  pdfText: typeof extractPdfLines,
): Promise<{ sections: ContractSection[]; excerpts: Excerpt[] }> {
  return (async () => {
    const sections: ContractSection[] = [];
    const excerpts: Excerpt[] = [];
    for (const file of fetched) {
      const pages = await pdfText(file.bytes);
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
  })();
}

type TermsCarryKey = "payment_terms" | "terms_crosscheck" | "term_clause" | "term_bounds";

// The pool of carry sources, newest first; a source lends only the calls
// whose digest matches — needs_review receipts are filtered out.
function makeCarryLookup(config: PipelineConfig) {
  const carrySources = (
    config.carrySources ?? (config.previous !== undefined ? [config.previous] : [])
  ).filter(
    (s) => s.receipt.status === "reviewable" && s.receipt.typedCallDigests !== undefined,
  );
  return (key: TermsCarryKey, digest: string) =>
    carrySources.find((s) => s.receipt.typedCallDigests?.[key] === digest);
}

async function loadTermsAssumptions(
  fixturesDir: string,
  profile: ContractProfile,
): Promise<TermsAssumptions> {
  const raw = await readFile(`${fixturesDir}/${profile.assumptionsFixture}`, "utf8");
  try {
    return JSON.parse(raw) as TermsAssumptions;
  } catch (error) {
    throw new PipelineError(
      "assumptions",
      new Error(`${profile.assumptionsFixture} is not valid JSON`, { cause: error }),
    );
  }
}

// The worker pool: injected in tests, otherwise one Custom API connector per
// worker pointing at that worker's org-private Sprite URL.
function resolvePool(
  connectors: Connectors,
  config: PipelineConfig,
): { ok: true; pool: WorkerPool } | { ok: false; detail: string } {
  if (config.workerPool !== undefined) return { ok: true, pool: config.workerPool };
  const spec = config.workers ?? readEnv("CAVEAT_WORKERS") ?? DEFAULT_WORKERS;
  const gateways: Record<string, string> = {};
  for (const entry of spec.split(",").map((e) => e.trim()).filter((e) => e.length > 0)) {
    const eq = entry.indexOf("=");
    const worker = eq === -1 ? entry : entry.slice(0, eq).trim();
    const connector = eq === -1 ? entry : entry.slice(eq + 1).trim();
    const conn = connectors.all.find((c) => c.name === connector);
    if (conn === undefined) {
      return {
        ok: false,
        detail: `the ${connector} connector is not configured on the gateway`,
      };
    }
    gateways[worker] = conn.gatewayBaseUrl;
  }
  return { ok: true, pool: new SpritesHttpPool({ gateways }) };
}

export async function runGenericPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const profile = contractProfile(config.contract ?? DEFAULT_CONTRACT);
  if (profile === undefined || profile.path !== "payment_terms") {
    throw new PipelineError(
      "contract",
      new Error(`no payment_terms profile for ${JSON.stringify(config.contract)}`),
    );
  }
  const blockedReasons: { reason: string; detail: string }[] = [];
  const reran: string[] = [];
  const carriedForward: string[] = [];
  const carrySourceFor = makeCarryLookup(config);
  const previous = config.previous;
  const baselineOk =
    previous !== undefined &&
    previous.receipt.status === "reviewable" &&
    previous.receipt.sectionDigests !== undefined &&
    previous.receipt.typedCallDigests !== undefined;

  const connectors = await connectGeneric(config);
  const folderName = config.boxFolder ?? profile.boxFolder;
  const { sourceTuple, fetched, cashFile, replyFile } = await fetchSources(
    connectors.boxConn,
    profile,
    folderName,
  );
  const { sections, excerpts } = await sectionize(
    fetched,
    config.pdfText ?? extractPdfLines,
  );
  const sectionDigests = await buildSectionDigests(sections);
  const flags = detectFlags(sections);
  const model = config.decisionModel ?? "nvidia/nemotron-3.5-super-vl:free";

  // --- Typed extraction ----------------------------------------------------
  const excerptsDigestInput = excerpts.map((e) => ({ id: e.id, text: e.text }));
  const termsDigest = digestValue({
    schemaName: "payment_terms",
    schema: PAYMENT_TERMS_JSON_SCHEMA,
    systemPrompt: DECISION_SYSTEM_PROMPT,
    model,
    questionId: "payment_terms",
    excerpts: excerptsDigestInput,
  });
  const termsSource = carrySourceFor("payment_terms", termsDigest);
  const prevTerms = termsSource?.receipt.paymentTerms?.outcome;
  let termsOutcome: PaymentTermsOutcome;
  let termClause: NonNullable<RunReceipt["paymentTerms"]>["termClause"];
  let termBounds: NonNullable<RunReceipt["paymentTerms"]>["termBounds"];
  let termClauseDigest: string | undefined;
  let termBoundsDigest: string | undefined;
  if (prevTerms?.status === "extracted" && termsSource !== undefined) {
    termsOutcome = { ...prevTerms, carriedFrom: termsSource.runId };
    carriedForward.push("payment_terms");
    if (prevTerms.terms.boundsFrom === "term_bounds") {
      termClause = termsSource.receipt.paymentTerms?.termClause;
      if (termClause !== undefined) termClause = { ...termClause, carriedFrom: termsSource.runId };
      termBounds = termsSource.receipt.paymentTerms?.termBounds;
      if (termBounds !== undefined) termBounds = { ...termBounds, carriedFrom: termsSource.runId };
      const sd = termsSource.receipt.typedCallDigests;
      if (sd?.term_clause !== undefined) termClauseDigest = sd.term_clause;
      if (sd?.term_bounds !== undefined) termBoundsDigest = sd.term_bounds;
      carriedForward.push("term_clause", "term_bounds");
    }
  } else {
    // The free tier's reasoning model can exceed the 60s default on a
    // full-document extraction; give this call extra headroom.
    const extractor = new OpenRouterPaymentTermsExtractor({
      gatewayBaseUrl: connectors.openrouterConn.gatewayBaseUrl,
      model,
      timeoutMs: 300_000,
    });
    termsOutcome = await extractor.extract({ id: "payment_terms", excerpts });
    reran.push("payment_terms");
  }

  // --- Staged term bounds ---------------------------------------------------
  // A recurring term needs the agreement's bounds to expand into invoices.
  // When the main extraction left them null, Jev picks the term clause and a
  // second extraction reads just the dates — over the picked excerpt when the
  // pick is confident, over all of them otherwise. Each call carries by its
  // own digest like the other typed calls.
  if (
    termsOutcome.status === "needs_review" &&
    termsOutcome.reason === "missing_term_bounds" &&
    termsOutcome.partialTerms !== undefined
  ) {
    const partial = termsOutcome.partialTerms;
    let boundsExcerpts = excerpts;
    let pick:
      | { choice: string; confidence: number; probabilities: Record<string, number>; model: string }
      | undefined;
    if (connectors.typesafeConn !== undefined) {
      const clauseDigest = digestValue(buildTermClauseDigestInput(excerpts, JEV_MODEL));
      termClauseDigest = clauseDigest;
      const clauseSource = carrySourceFor("term_clause", clauseDigest);
      const prevClause = clauseSource?.receipt.paymentTerms?.termClause;
      if (prevClause !== undefined && clauseSource !== undefined) {
        pick = prevClause;
        termClause = { ...prevClause, carriedFrom: clauseSource.runId };
        carriedForward.push("term_clause");
      } else {
        const jev = new JevDecisionProvider({
          gatewayBaseUrl: connectors.typesafeConn.gatewayBaseUrl,
        });
        const picked = await jev.pickTermClause(excerpts);
        if (picked.status === "failed") {
          blockedReasons.push({ reason: picked.reason, detail: picked.detail });
        } else {
          pick = picked.pick;
          termClause = {
            question: "term_clause",
            choice: picked.pick.choice,
            confidence: picked.pick.confidence,
            probabilities: picked.pick.probabilities,
            model: picked.pick.model,
            ...(picked.pick.usage !== undefined ? { usage: picked.pick.usage } : {}),
            narrowed: picked.pick.confidence >= 0.8,
          };
          reran.push("term_clause");
        }
      }
      if (pick !== undefined && pick.confidence >= 0.8) {
        const index = Number(pick.choice.slice(1)) - 1;
        const chosen = excerpts[index];
        if (chosen !== undefined) boundsExcerpts = [chosen];
      }
    }
    // The bounds call runs unless the clause call failed (its blocker is
    // already recorded).
    if (connectors.typesafeConn === undefined || termClause !== undefined) {
      const boundsDigest = digestValue({
        schemaName: "term_bounds",
        schema: TERM_BOUNDS_JSON_SCHEMA,
        systemPrompt: DECISION_SYSTEM_PROMPT,
        model,
        questionId: "term_bounds",
        excerpts: boundsExcerpts.map((e) => ({ id: e.id, text: e.text })),
      });
      termBoundsDigest = boundsDigest;
      const boundsSource = carrySourceFor("term_bounds", boundsDigest);
      const prevBounds = boundsSource?.receipt.paymentTerms?.termBounds;
      let bounds: { termStart: ValidatedPaymentTerms["termStart"]; termEnd: ValidatedPaymentTerms["termEnd"] } | undefined;
      if (prevBounds !== undefined && boundsSource !== undefined) {
        bounds = prevBounds;
        termBounds = { ...prevBounds, carriedFrom: boundsSource.runId };
        carriedForward.push("term_bounds");
      } else {
        const boundsExtractor = new OpenRouterPaymentTermsExtractor({
          gatewayBaseUrl: connectors.openrouterConn.gatewayBaseUrl,
          model,
          timeoutMs: 300_000,
        });
        const res = await boundsExtractor.extractTermBounds(boundsExcerpts);
        if (res.status === "extracted") {
          bounds = res;
          termBounds = { termStart: res.termStart, termEnd: res.termEnd, model: res.model };
          reran.push("term_bounds");
        } else {
          blockedReasons.push({ reason: res.reason, detail: res.detail });
        }
      }
      if (bounds !== undefined) {
        const merged: ValidatedPaymentTerms = {
          ...partial,
          termStart: partial.termStart ?? bounds.termStart,
          termEnd: partial.termEnd ?? bounds.termEnd,
          boundsFrom: "term_bounds",
          ...(pick !== undefined ? { boundsPick: pick } : {}),
        };
        if (merged.termStart !== null && merged.termEnd !== null) {
          termsOutcome = {
            status: "extracted",
            terms: merged,
            provider: termsOutcome.provider,
            model: termsOutcome.model ?? model,
            latencyMs: 0,
          };
        } else {
          termsOutcome = { ...termsOutcome, partialTerms: merged };
        }
      }
    }
  }

  if (termsOutcome.status === "needs_review") {
    blockedReasons.push({ reason: termsOutcome.reason, detail: termsOutcome.detail });
  }

  // --- Jev per-term cross-check ---------------------------------------------
  // Jev verifies the extraction's restated clause on every term against that
  // term's own quote. Carries by its own digest like the other typed calls.
  let termsCrosscheck: JevCrosscheck[] | undefined;
  let termsCrosscheckDigest: string | undefined;
  if (connectors.typesafeConn !== undefined && termsOutcome.status === "extracted") {
    const requests = buildTermCrosscheckRequests(termsOutcome.terms.terms, JEV_MODEL);
    if (requests === undefined) {
      blockedReasons.push({
        reason: "schema_mismatch",
        detail: "an extracted term lacks the texts its cross-check instruction needs",
      });
    } else {
      const digest = digestValue({ provider: "typesafe", requests });
      termsCrosscheckDigest = digest;
      const crosscheckSource = carrySourceFor("terms_crosscheck", digest);
      const prevCrosscheck = crosscheckSource?.receipt.paymentTerms?.crosscheck;
      if (prevCrosscheck !== undefined && prevCrosscheck.length > 0) {
        termsCrosscheck = prevCrosscheck;
        carriedForward.push("terms_crosscheck");
      } else {
        const jev = new JevDecisionProvider({
          gatewayBaseUrl: connectors.typesafeConn.gatewayBaseUrl,
        });
        const outcome = await jev.crosscheckPaymentTerms(termsOutcome.terms.terms);
        reran.push("terms_crosscheck");
        if (outcome.status === "pass") {
          termsCrosscheck = outcome.checks;
        } else if (outcome.status === "failed") {
          blockedReasons.push({ reason: outcome.reason, detail: outcome.detail });
        } else {
          termsCrosscheck = outcome.checks;
          blockedReasons.push({
            reason:
              outcome.status === "mismatch" ? "jev_crosscheck_mismatch" : "low_confidence",
            detail: outcome.detail,
          });
        }
      }
    }
  }

  // --- Reviewer confirmation ------------------------------------------------
  // Every extracted term needs a confirmed entry in the private review file.
  let confirmation: TermsReviewCheck | undefined;
  if (termsOutcome.status === "extracted") {
    confirmation = await loadTermsConfirmation(config, profile, termsOutcome, sections);
    if (confirmation.status === "needs_review") {
      blockedReasons.push({ reason: confirmation.reason, detail: confirmation.detail });
    }
  }

  // --- Cash numbers -----------------------------------------------------------
  const demoAssumptions = await loadTermsAssumptions(config.fixturesDir, profile);
  let assumptions = demoAssumptions;
  let cashSource: NonNullable<RunReceipt["cashSource"]> = { kind: "demo_assumptions" };
  let cashInvalid = false;
  if (cashFile !== undefined) {
    const firstPay =
      termsOutcome.status === "extracted"
        ? (firstPaymentDate(termsOutcome.terms) ??
          termsOutcome.terms.termStart?.iso ??
          demoAssumptions.startDate)
        : demoAssumptions.startDate;
    const parsed = parseTermsCashFile(cashFile.bytes, firstPay);
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

  // --- Readings on both workers -------------------------------------------------
  // The readings need confirmed terms: they run only when the reviewer
  // confirmed, the cash numbers are usable and nothing earlier blocked.
  const readings: ReceiptReading[] = [];
  if (
    blockedReasons.length === 0 &&
    !cashInvalid &&
    termsOutcome.status === "extracted" &&
    confirmation?.status === "confirmed"
  ) {
    const built = buildTermsReadings({
      terms: termsOutcome.terms,
      assumptions,
      labelPrefix: `${profile.id}-terms`,
    });
    if (!built.ok) {
      blockedReasons.push({ reason: built.error.reason, detail: built.error.detail });
    } else {
      const runReadingsOutcome = await runReadingsOnWorkers(connectors, config, built.inputs);
      if ("reason" in runReadingsOutcome) {
        blockedReasons.push({
          reason: runReadingsOutcome.reason,
          detail: runReadingsOutcome.detail,
        });
      } else {
        readings.push(...runReadingsOutcome.readings);
      }
    }
  }

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
    questionIds: ["payment_terms"],
    sources: [
      ...fetched.map((f) => ({
        fileName: f.fileName,
        versionLabel: `sha256 ${f.sha256.slice(0, 12)}`,
        versionPresent: f.versionPresent,
        edgarUrl: profile.edgarUrls[f.fileName] ?? null,
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
    sectionDigests,
    typedCallDigests: {
      payment_terms: termsDigest,
      ...(termsCrosscheckDigest !== undefined
        ? { terms_crosscheck: termsCrosscheckDigest }
        : {}),
      ...(termClauseDigest !== undefined ? { term_clause: termClauseDigest } : {}),
      ...(termBoundsDigest !== undefined ? { term_bounds: termBoundsDigest } : {}),
    },
    releaseTiming: null,
    effectiveAction: null,
    overrides: [],
    schedule: null,
    paymentTerms: {
      outcome: termsOutcome,
      excerpts,
      ...(termsCrosscheck !== undefined ? { crosscheck: termsCrosscheck } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
      ...(termClause !== undefined ? { termClause } : {}),
      ...(termBounds !== undefined ? { termBounds } : {}),
    },
    humanReview: { status: "not_applicable" },
    flags,
    readings,
    assumptions,
    ...(incremental !== undefined ? { incremental } : {}),
  };
  return { receipt, sourceTuple, sections, timingsMs: {} };
}

async function buildSectionDigests(
  sections: ContractSection[],
): Promise<Record<string, string>> {
  const { createHash } = await import("node:crypto");
  const digests: Record<string, string> = {};
  for (const section of sections) {
    digests[`${section.fileName}#${section.sectionId}`] = createHash("sha256")
      .update(section.text)
      .digest("hex");
  }
  return digests;
}

// Loads and validates the profile's private review file; an absent or
// unreadable file leaves every term unconfirmed.
async function loadTermsConfirmation(
  config: PipelineConfig,
  profile: ContractProfile,
  outcome: Extract<PaymentTermsOutcome, { status: "extracted" }>,
  sections: ContractSection[],
): Promise<TermsReviewCheck> {
  const fileName = profile.reviewFileName;
  if (fileName === undefined) {
    return {
      status: "needs_review",
      reason: "terms_unconfirmed",
      detail: "this contract profile has no terms-review file",
      extras: [],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(`${config.reviewsDir}/${fileName}`, "utf8"));
  } catch {
    return {
      status: "needs_review",
      reason: "terms_unconfirmed",
      detail: `no reviewer confirmation file at ${fileName}`,
      extras: [],
    };
  }
  return validateTermsReview(raw, outcome.terms.terms, sections);
}

// Runs both readings on every worker and requires identical digests: each
// worker's inputDigest must equal the coordinator's local digest and every
// resultDigest must agree — the same agreement rule as the candidate tests.
async function runReadingsOnWorkers(
  connectors: Connectors,
  config: PipelineConfig,
  inputs: Record<string, Record<string, unknown>>,
): Promise<{ readings: ReceiptReading[] } | { reason: string; detail: string }> {
  const resolved = resolvePool(connectors, config);
  if (!resolved.ok) {
    return { reason: "workers_unavailable", detail: resolved.detail };
  }
  const pool = resolved.pool;
  const workers = [...pool.workers];
  if (workers.length < 2) {
    return {
      reason: "workers_unavailable",
      detail: `the readings need at least 2 workers, the pool has ${workers.length}`,
    };
  }

  const readingIds = Object.keys(inputs);
  const local = new Map<string, ReturnType<typeof runFixture>>();
  const jobs: WorkerJob[] = [];
  for (const id of readingIds) {
    const rawInput = inputs[id]!;
    let input;
    try {
      input = validateRunInput(rawInput);
    } catch (error) {
      if (error instanceof RunInputError) {
        return { reason: "input_invalid", detail: `${id}: ${error.message}` };
      }
      throw error;
    }
    local.set(id, runFixture(input));
    jobs.push({ jobId: id, input: rawInput });
  }

  let perWorker: [string, WorkerJobResult[]][];
  try {
    perWorker = await Promise.all(
      workers.map(async (worker) => [worker, await pool.runBatch(worker, jobs)] as const),
    );
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      return { reason: "workers_unavailable", detail: error.message };
    }
    throw error;
  }

  for (const [worker, results] of perWorker) {
    for (const id of readingIds) {
      const result = results.find((r) => r.jobId === id);
      if (result === undefined) {
        return {
          reason: "workers_unavailable",
          detail: `worker ${worker} returned no result for ${id}`,
        };
      }
      if (!result.ok) {
        return { reason: result.code, detail: `worker ${worker}: ${result.message}` };
      }
      const output = result.output;
      const expected = local.get(id)!;
      if (
        output.runnerVersion !== RUNNER_VERSION ||
        output.inputDigest !== expected.inputDigest
      ) {
        return {
          reason: "worker_digest_mismatch",
          detail: `worker ${worker} output for ${id} does not match the coordinator's input digest`,
        };
      }
      if (output.resultDigest !== expected.resultDigest) {
        return {
          reason: "worker_disagreement",
          detail: `worker ${worker} resultDigest for ${id} differs from the coordinator's`,
        };
      }
    }
  }

  const readings: ReceiptReading[] = [];
  for (const id of readingIds) {
    const output = local.get(id)!;
    const validated = validateRunInput(inputs[id]!);
    readings.push({
      id,
      label:
        TERMS_READING_LABELS[id as keyof typeof TERMS_READING_LABELS] ?? id,
      inputDigest: output.inputDigest,
      resultDigest: output.resultDigest,
      smallestPassingCandidate: output.smallestPassingCandidate,
      results: output.results,
      adjustments: inputAdjustments(validated),
    });
  }
  return { readings };
}

// policyAdjustments runs against the validated input per scenario.
function inputAdjustments(input: ReturnType<typeof validateRunInput>) {
  return input.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    adjustments: policyAdjustments(input, scenario),
  }));
}
