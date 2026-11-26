import { digestValue } from "../runner/digest.ts";
import { RUNNER_VERSION } from "../runner/run.ts";
import type { PaymentRule, ScenarioResult } from "../runner/types.ts";
import { callStructuredChat, modelInfo } from "../interpret/chat.ts";
import type { ChatResult, StructuredChatConfig } from "../interpret/chat.ts";
import type { WorkerJob, WorkerJobResult, WorkerPool } from "../worker/pool.ts";
import { WorkerUnavailableError } from "../worker/pool.ts";
import { compileCandidate } from "./levers.ts";
import type { CompileOk, Lever, ProposedCandidate, SearchBase } from "./levers.ts";
import { COUNTEROFFER_SYSTEM_PROMPT } from "./prompt.ts";
import { PROPOSAL_SCHEMA, PROPOSAL_SCHEMA_NAME } from "./schema.ts";
import { validateProposal } from "./validate.ts";

export type CompactResult = {
  passes: boolean;
  lowest: { date: string; balanceCents: number };
  firstBreach: { date: string; week: number; balanceCents: number } | null;
};

export type SearchCandidateRecord = {
  id: string;
  lever: Lever;
  params: {
    amount_cents: number | null;
    date: string | null;
    split_count: number | null;
    net_days: number | null;
  };
  rationale: string;
  status: "tested" | "rejected_malformed" | "duplicate";
  duplicateOf?: string;
  rejection?: { by: "compile" | "runner"; code: string; field?: string; detail: string };
  worker?: string;
  rankCents?: number;
  centDays?: number;
  summary?: string;
  passesAll?: boolean | undefined;
  perScenario?: Record<string, Record<string, CompactResult>> | undefined;
  inputDigests?: Record<string, string> | undefined;
  resultDigests?: Record<string, string> | undefined;
  // For the client counter record: every worker it was tested on.
  workers?: string[];
};

export type SearchRound = {
  round: number;
  modelNote: string;
  done: boolean;
  modelVersion?: string;
  servedBy?: string;
  candidates: SearchCandidateRecord[];
};

export type SearchStopReason =
  | "model_done"
  | "round_cap"
  | "model_error"
  | "worker_error"
  | "not_applicable";

// The tested failing candidate closest below the best candidate in its lever
// family — evidence that the found change is minimal, not just the smallest
// tried. gap is in the family's size units: cents, or days for
// shorter_payment_terms (whose size param is net_days).
export type CounterofferBound = {
  candidate: string;
  gap: { unit: "cents" | "days"; value: number };
};

export type CounterofferReceipt = {
  status: "found" | "not_found" | "needs_review" | "not_needed";
  stopReason: SearchStopReason;
  reason?: string;
  detail?: string;
  model: string;
  rounds: SearchRound[];
  best: string | null;
  humanReview: string[];
  bound?: CounterofferBound | null;
  // Set when the whole search outcome was reused verbatim from an earlier run
  // (the best candidate was re-verified on a worker, not re-searched).
  carriedFrom?: string;
  // The worker a carried "found" outcome was re-verified on.
  reverifiedOn?: string;
};

export type SearchReading = {
  id: string;
  label: string;
  // The exact object buildTwinveeInputs produced — kept raw so the worker's
  // inputDigest matches the coordinator's recompute.
  rawInput: {
    candidates: { id: string; rankCents: number; totalCents: number; paymentRules: PaymentRule[] }[];
    scenarios: { id: string; extensionsGranted?: string[] }[];
    [key: string]: unknown;
  };
  asSignedResults: Record<string, ScenarioResult>;
};

export type SearchArgs = {
  base: SearchBase;
  readings: SearchReading[];
  model: string;
  chatConfig: StructuredChatConfig;
  pool: WorkerPool;
  maxRounds?: number;
  chat?: typeof callStructuredChat;
  conditionalReleases?: { id: string; amountCents: number; date: string; extensionId: string }[];
  // Already-tested records seeded into the brackets (the client's own
  // counter). They join allRecords and the prompt but never rounds, so they
  // can serve as the bound yet can never be chosen as best.
  seedRecords?: SearchCandidateRecord[];
  // Prefix for generated candidate ids ("reply-" keeps reply-search ids
  // distinct from the main search's).
  idPrefix?: string;
  // Extra system-prompt text appended to COUNTEROFFER_SYSTEM_PROMPT.
  systemPromptSuffix?: string;
};

const DEFAULT_MAX_ROUNDS = 4;

function compact(result: ScenarioResult): CompactResult {
  return { passes: result.passes, lowest: result.lowest, firstBreach: result.firstBreach };
}

function allPass(results: Record<string, ScenarioResult>): boolean {
  return Object.values(results).every((r) => r.passes);
}

function receipt(args: {
  status: CounterofferReceipt["status"];
  stopReason: SearchStopReason;
  model: string;
  rounds: SearchRound[];
  reason?: string;
  detail?: string;
  best?: string | null;
}): CounterofferReceipt {
  const humanReview = args.rounds
    .flatMap((r) => r.candidates)
    .filter((c) => c.status === "rejected_malformed")
    .map((c) => c.id);
  return {
    status: args.status,
    stopReason: args.stopReason,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
    model: args.model,
    rounds: args.rounds,
    best: args.best ?? null,
    humanReview,
    bound: null,
  };
}

function findBest(rounds: SearchRound[]): SearchCandidateRecord | null {
  let best: SearchCandidateRecord | null = null;
  let bestKey: [number, number, number, number] | null = null;
  rounds.forEach((round, roundIndex) => {
    round.candidates.forEach((candidate, index) => {
      if (candidate.status !== "tested" || candidate.passesAll !== true) return;
      const key: [number, number, number, number] = [
        candidate.rankCents ?? Number.MAX_SAFE_INTEGER,
        candidate.centDays ?? Number.MAX_SAFE_INTEGER,
        roundIndex,
        index,
      ];
      if (
        bestKey === null ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] &&
              (key[2] < bestKey[2] || (key[2] === bestKey[2] && key[3] < bestKey[3])))))
      ) {
        best = candidate;
        bestKey = key;
      }
    });
  });
  return best;
}

export type BracketEndpoint = {
  id: string;
  amount_cents: number | null;
  net_days: number | null;
  rankCents: number | null;
};

export type TestedBracket = {
  lever: Lever;
  date: string | null;
  split_count: number | null;
  smallestPass: BracketEndpoint | null;
  largestFail: BracketEndpoint | null;
};

// The lever family a candidate belongs to: the lever plus the params held
// fixed while narrowing. The size param is the one being narrowed —
// amount_cents for the first three levers, net_days for
// shorter_payment_terms.
function familyKey(record: SearchCandidateRecord): string {
  const p = record.params;
  if (record.lever === "shorter_payment_terms") return record.lever;
  const parts = [record.lever, p.date ?? ""];
  if (record.lever === "milestone_split") parts.push(String(p.split_count ?? ""));
  return parts.join("|");
}

// Ordering where a smaller metric means a smaller change: fewer cents for the
// amount levers, MORE net days for shorter_payment_terms.
function changeMetric(record: SearchCandidateRecord): number {
  return record.lever === "shorter_payment_terms"
    ? -(record.params.net_days ?? 0)
    : (record.params.amount_cents ?? 0);
}

function bracketEndpoint(record: SearchCandidateRecord): BracketEndpoint {
  return {
    id: record.id,
    amount_cents: record.params.amount_cents,
    net_days: record.params.net_days,
    rankCents: record.rankCents ?? null,
  };
}

// Per lever family: the passing candidate with the smallest change, and the
// failing candidate with the largest change still below it (or the largest
// failing change at all when nothing passed). Only tested candidates count; a
// duplicate's verdict already counts once under its original's id.
// One family's bracket: the passing candidate with the smallest change, and
// the failing candidate with the largest change still below it (or the
// largest failing change at all when nothing passed).
function familyBracket(list: SearchCandidateRecord[]): TestedBracket {
  const first = list[0] as SearchCandidateRecord;
  const passes = list.filter((c) => c.passesAll === true);
  const fails = list.filter((c) => c.passesAll === false);
  const smallestPass =
    passes.length === 0
      ? undefined
      : passes.reduce((a, b) => (changeMetric(b) < changeMetric(a) ? b : a));
  let largestFail: SearchCandidateRecord | undefined;
  if (smallestPass === undefined) {
    if (fails.length > 0) {
      largestFail = fails.reduce((a, b) => (changeMetric(b) > changeMetric(a) ? b : a));
    }
  } else {
    const below = fails.filter((c) => changeMetric(c) < changeMetric(smallestPass));
    if (below.length > 0) {
      largestFail = below.reduce((a, b) => (changeMetric(b) > changeMetric(a) ? b : a));
    }
  }
  return {
    lever: first.lever,
    date: first.params.date,
    split_count: first.params.split_count,
    smallestPass: smallestPass === undefined ? null : bracketEndpoint(smallestPass),
    largestFail: largestFail === undefined ? null : bracketEndpoint(largestFail),
  };
}

export function testedBrackets(records: SearchCandidateRecord[]): TestedBracket[] {
  const families = new Map<string, SearchCandidateRecord[]>();
  for (const record of records) {
    if (record.status !== "tested" || typeof record.passesAll !== "boolean") continue;
    const key = familyKey(record);
    const list = families.get(key) ?? [];
    list.push(record);
    families.set(key, list);
  }
  const brackets: TestedBracket[] = [];
  for (const list of families.values()) {
    brackets.push(familyBracket(list));
  }
  return brackets;
}

// The failing bound for the best candidate's family: the tested failure with
// the largest change still smaller than the best's.
function boundOf(
  best: SearchCandidateRecord,
  records: SearchCandidateRecord[],
): CounterofferBound | null {
  const key = familyKey(best);
  const bestMetric = changeMetric(best);
  const fails = records.filter(
    (r) =>
      r.status === "tested" &&
      r.passesAll === false &&
      familyKey(r) === key &&
      changeMetric(r) < bestMetric,
  );
  if (fails.length === 0) return null;
  const bound = fails.reduce((a, b) => (changeMetric(b) > changeMetric(a) ? b : a));
  const netDays = best.lever === "shorter_payment_terms";
  const bestSize = netDays ? best.params.net_days : best.params.amount_cents;
  const boundSize = netDays ? bound.params.net_days : bound.params.amount_cents;
  return {
    candidate: bound.id,
    gap: {
      unit: netDays ? "days" : "cents",
      value: Math.abs((bestSize ?? 0) - (boundSize ?? 0)),
    },
  };
}

function buildUserPrompt(args: {
  round: number;
  maxRounds: number;
  search: SearchArgs;
  previousRounds: SearchRound[];
}): string {
  const { search, previousRounds } = args;
  const scenarios = search.readings.flatMap((reading) =>
    reading.rawInput.scenarios.map((scen) => ({
      id: scen.id,
      reading: reading.id,
      extensionsGranted: scen.extensionsGranted ?? [],
    })),
  );
  const baseline: Record<string, Record<string, unknown>> = {};
  for (const reading of search.readings) {
    const perReading: Record<string, unknown> = {};
    baseline[reading.id] = perReading;
    for (const [scenarioId, result] of Object.entries(reading.asSignedResults)) {
      perReading[scenarioId] = {
        passes: result.passes,
        lowest: result.lowest,
        firstBreach: result.firstBreach,
      };
    }
  }
  const rounds = previousRounds.map((round) => ({
    round: round.round,
    candidates: round.candidates.map((c) => ({
      id: c.id,
      lever: c.lever,
      params: c.params,
      status: c.status,
      ...(c.rejection !== undefined ? { rejection: c.rejection } : {}),
      ...(c.rankCents !== undefined ? { rankCents: c.rankCents } : {}),
      ...(c.passesAll !== undefined ? { passesAll: c.passesAll } : {}),
      ...(c.perScenario !== undefined ? { perScenario: c.perScenario } : {}),
    })),
  }));
  const firstRelease = {
    contractDate: search.base.r1Date,
    amountCents: search.base.r1AmountCents,
    monthsCovered: search.base.monthsCovered,
    monthlyCents: search.base.monthlyCents,
  };
  const demo = (
    search.readings[0]?.rawInput as {
      demoAssumptions?: { openingCents?: number; floorCents?: number };
    }
  ).demoAssumptions;
  return JSON.stringify({
    round: args.round,
    roundsRemaining: args.maxRounds - args.round,
    floorCents: demo?.floorCents,
    demoAssumptions: {
      note: "demo assumptions, not facts about the parties",
      openingCents: demo?.openingCents,
      escrowFundingDate: search.base.fundingDate,
    },
    firstRelease,
    conditionalReleases: search.conditionalReleases ?? [],
    scenarios,
    baseline,
    testedBrackets: testedBrackets([
      ...(search.seedRecords ?? []),
      ...previousRounds.flatMap((r) => r.candidates),
    ]),
    ...(search.seedRecords !== undefined && search.seedRecords.length > 0
      ? {
          clientCounter: search.seedRecords.map((c) => ({
            id: c.id,
            lever: c.lever,
            params: c.params,
            ...(c.summary !== undefined ? { summary: c.summary } : {}),
            passesAll: c.passesAll ?? null,
            ...(c.perScenario !== undefined ? { perScenario: c.perScenario } : {}),
          })),
        }
      : {}),
    previousRounds: rounds,
  });
}

// The counteroffer search: propose -> compile -> run on workers -> repeat.
// The runner is the only source of numbers; the model only proposes.
type Runnable = { record: SearchCandidateRecord; escrowRules: PaymentRule[] };

type RoundJobs = {
  batchResults: Map<string, WorkerJobResult>;
  localDigests: Map<string, string>;
};

// Builds each runnable candidate's per-reading job, assigns workers
// round-robin, runs every batch concurrently and collects results by jobId.
async function runRoundJobs(
  runnable: Runnable[],
  readings: SearchReading[],
  escrowIds: Set<string>,
  pool: WorkerPool,
): Promise<{ ok: true } & RoundJobs | { ok: false; detail: string }> {
  const jobsByWorker = new Map<string, WorkerJob[]>();
  const localDigests = new Map<string, string>();
  runnable.forEach((candidate, i) => {
    const worker = pool.workers[i % pool.workers.length] as string;
    candidate.record.worker = worker;
    for (const reading of readings) {
      const asSigned = reading.rawInput.candidates[0];
      const nonEscrow = (asSigned?.paymentRules ?? []).filter((r) => !escrowIds.has(r.id));
      const input = {
        ...reading.rawInput,
        candidates: [
          {
            id: candidate.record.id,
            rankCents: candidate.record.rankCents ?? 0,
            totalCents: asSigned?.totalCents ?? 0,
            paymentRules: [...candidate.escrowRules, ...nonEscrow],
          },
        ],
      };
      const jobId = `${candidate.record.id}@${reading.id}`;
      localDigests.set(jobId, digestValue(input));
      const list = jobsByWorker.get(worker) ?? [];
      list.push({ jobId, input });
      jobsByWorker.set(worker, list);
    }
  });

  const batchResults = new Map<string, WorkerJobResult>();
  try {
    const settled = await Promise.all(
      [...jobsByWorker.entries()].map(([worker, jobs]) =>
        pool.runBatch(worker, jobs).then((results) => ({ worker, results })),
      ),
    );
    for (const { results } of settled) {
      for (const result of results) batchResults.set(result.jobId, result);
    }
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      return { ok: false, detail: error.message };
    }
    throw error;
  }
  return { ok: true, batchResults, localDigests };
}

// Writes each runnable's outcome back onto its record: per-scenario verdicts
// and input/result digests, or a runner rejection when the job failed.
function foldRoundResults(
  runnable: Runnable[],
  readings: SearchReading[],
  ran: RoundJobs,
): { ok: true } | { ok: false; reason: string; detail: string } {
  for (const candidate of runnable) {
    const record = candidate.record;
    record.perScenario = {};
    record.inputDigests = {};
    record.resultDigests = {};
    for (const reading of readings) {
      const jobId = `${record.id}@${reading.id}`;
      const result = ran.batchResults.get(jobId);
      if (result === undefined) {
        return {
          ok: false,
          reason: "workers_unavailable",
          detail: `worker returned no result for ${jobId}`,
        };
      }
      if (!result.ok) {
        record.status = "rejected_malformed";
        record.rejection = {
          by: "runner",
          code: result.code,
          ...(result.field !== undefined ? { field: result.field } : {}),
          detail: result.message,
        };
        record.perScenario = undefined;
        record.inputDigests = undefined;
        record.resultDigests = undefined;
        break;
      }
      const output = result.output;
      if (output.runnerVersion !== RUNNER_VERSION || output.inputDigest !== ran.localDigests.get(jobId)) {
        return {
          ok: false,
          reason: "worker_digest_mismatch",
          detail: `worker output for ${jobId} does not match the coordinator's input digest`,
        };
      }
      const perScenario: Record<string, CompactResult> = {};
      for (const [scenarioId, scenarioResult] of Object.entries(
        output.results[record.id] ?? {},
      )) {
        perScenario[scenarioId] = compact(scenarioResult);
      }
      record.perScenario[reading.id] = perScenario;
      record.inputDigests[reading.id] = output.inputDigest;
      record.resultDigests[reading.id] = output.resultDigest;
    }
    if (record.status === "tested") {
      record.passesAll = readings.every((reading) =>
        reading.rawInput.scenarios.every(
          (scen) => record.perScenario?.[reading.id]?.[scen.id]?.passes === true,
        ),
      );
    }
  }
  return { ok: true };
}

// Compile one round's proposed candidates, recording each in the round and in
// allRecords: malformed proposals are rejected, rule-identical ones marked
// duplicates of the first identical candidate, and the rest are runnable.
function compileRoundCandidates(args: {
  search: SearchArgs;
  round: number;
  roundRecord: SearchRound;
  candidates: ProposedCandidate[];
  allRecords: SearchCandidateRecord[];
  seenRules: Map<string, string>;
}): Runnable[] {
  const { search, round, roundRecord, candidates, allRecords, seenRules } = args;
  const runnable: Runnable[] = [];
  candidates.forEach((p, index) => {
    const record: SearchCandidateRecord = {
      id: `${search.idPrefix ?? ""}r${round}c${index + 1}`,
      lever: p.lever,
      params: {
        amount_cents: p.amount_cents,
        date: p.date,
        split_count: p.split_count,
        net_days: p.net_days,
      },
      rationale: p.rationale,
      status: "tested",
    };
    allRecords.push(record);
    roundRecord.candidates.push(record);
    const compiled = compileCandidate(search.base, p);
    if (!compiled.ok) {
      record.status = "rejected_malformed";
      record.rejection = {
        by: "compile",
        code: compiled.code,
        field: compiled.field,
        detail: compiled.detail,
      };
      return;
    }
    record.rankCents = compiled.rankCents;
    record.centDays = compiled.centDays;
    record.summary = compiled.summary;
    const rulesDigest = digestValue(compiled.escrowRules);
    const prior = seenRules.get(rulesDigest);
    if (prior !== undefined) {
      record.status = "duplicate";
      record.duplicateOf = prior;
      return;
    }
    seenRules.set(rulesDigest, record.id);
    runnable.push({ record, escrowRules: compiled.escrowRules });
  });
  return runnable;
}

// Duplicates reuse the original's outcome: the verdicts carry over, the
// digests do not — this candidate's own input (with its own id) never ran.
function propagateDuplicates(allRecords: SearchCandidateRecord[]): void {
  for (const record of allRecords) {
    if (record.status !== "duplicate" || record.duplicateOf === undefined) continue;
    const original = allRecords.find((c) => c.id === record.duplicateOf);
    if (original === undefined) continue;
    record.passesAll = original.passesAll;
    record.perScenario = original.perScenario;
  }
}

// One search round: ask the model, record the round, compile + dedupe its
// candidates, run them on workers and fold the results back. Returns a
// terminal receipt when the round ends the search (model or worker failure),
// undefined to continue.
async function runSearchRound(args: {
  round: number;
  maxRounds: number;
  search: SearchArgs;
  chat: typeof callStructuredChat;
  model: string;
  rounds: SearchRound[];
  allRecords: SearchCandidateRecord[];
  seenRules: Map<string, string>;
  escrowIds: Set<string>;
}): Promise<CounterofferReceipt | undefined> {
  const { round, maxRounds, search, chat, model, rounds, allRecords, seenRules, escrowIds } =
    args;
  const chatResult: ChatResult = await chat(search.chatConfig, {
    model,
    systemPrompt: COUNTEROFFER_SYSTEM_PROMPT + (search.systemPromptSuffix ?? ""),
    userPrompt: buildUserPrompt({ round, maxRounds, search, previousRounds: rounds }),
    schemaName: PROPOSAL_SCHEMA_NAME,
    schema: PROPOSAL_SCHEMA,
  });
  if (!chatResult.ok) {
    return receipt({
      status: "needs_review",
      stopReason: "model_error",
      reason: chatResult.reason,
      detail: chatResult.detail,
      model,
      rounds,
    });
  }
  const validated = validateProposal(chatResult.parsed);
  if (!validated.ok) {
    return receipt({
      status: "needs_review",
      stopReason: "model_error",
      reason: "schema_mismatch",
      detail: validated.detail,
      model,
      rounds,
    });
  }
  const proposal = validated.proposal;
  const roundRecord: SearchRound = {
    round,
    modelNote: proposal.roundNote,
    done: proposal.done,
    ...modelInfo(chatResult),
    candidates: [],
  };
  rounds.push(roundRecord);

  // Compile + dedupe ---------------------------------------------------------
  const runnable = compileRoundCandidates({
    search,
    round,
    roundRecord,
    candidates: proposal.candidates,
    allRecords,
    seenRules,
  });

  // Build + distribute jobs ----------------------------------------------------
  const ran = await runRoundJobs(runnable, search.readings, escrowIds, search.pool);
  if (!ran.ok) {
    return receipt({
      status: "needs_review",
      stopReason: "worker_error",
      reason: "workers_unavailable",
      detail: ran.detail,
      model,
      rounds,
    });
  }

  // Fold results back ----------------------------------------------------------
  const fold = foldRoundResults(runnable, search.readings, ran);
  if (!fold.ok) {
    return receipt({
      status: "needs_review",
      stopReason: "worker_error",
      reason: fold.reason,
      detail: fold.detail,
      model,
      rounds,
    });
  }

  propagateDuplicates(allRecords);
  return undefined;
}

// Early exits: both readings already pass as signed (nothing to search), or
// the worker pool is empty.
function preflightReceipt(
  args: SearchArgs,
  model: string,
  rounds: SearchRound[],
): CounterofferReceipt | undefined {
  if (args.readings.every((r) => allPass(r.asSignedResults))) {
    return receipt({
      status: "not_needed",
      stopReason: "not_applicable",
      model,
      rounds,
    });
  }
  if (args.pool.workers.length === 0) {
    return receipt({
      status: "needs_review",
      stopReason: "worker_error",
      reason: "workers_unavailable",
      detail: "the worker pool has no workers",
      model,
      rounds,
    });
  }
  return undefined;
}

export async function runCounterofferSearch(args: SearchArgs): Promise<CounterofferReceipt> {
  const maxRounds = args.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const chat = args.chat ?? callStructuredChat;
  const model = args.model;
  const rounds: SearchRound[] = [];
  const escrowIds = new Set(args.base.rules.map((r) => r.id));
  const seenRules = new Map<string, string>(); // rules digest -> first candidate id
  const allRecords: SearchCandidateRecord[] = [...(args.seedRecords ?? [])];

  const preflight = preflightReceipt(args, model, rounds);
  if (preflight !== undefined) return preflight;

  for (let round = 1; round <= maxRounds; round += 1) {
    const ended = await runSearchRound({
      round,
      maxRounds,
      search: args,
      chat,
      model,
      rounds,
      allRecords,
      seenRules,
      escrowIds,
    });
    if (ended !== undefined) return ended;
    if (rounds[rounds.length - 1]?.done === true) break;
  }

  return finalizeSearch(model, rounds, allRecords);
}

// The terminal receipt once the rounds end: best candidate, the stop reason
// (the model declared done vs the round cap) and the failing bound for the
// best's lever family.
function finalizeSearch(
  model: string,
  rounds: SearchRound[],
  allRecords: SearchCandidateRecord[],
): CounterofferReceipt {
  const best = findBest(rounds);
  const lastRound = rounds[rounds.length - 1];
  const stopReason: SearchStopReason =
    lastRound?.done === true ? "model_done" : "round_cap";
  const result = receipt({
    status: best === null ? "not_found" : "found",
    stopReason,
    model,
    rounds,
    best: best?.id ?? null,
  });
  if (best !== null) result.bound = boundOf(best, allRecords);
  return result;
}

// The digest that decides whether a previous run's counteroffer outcome can be
// carried forward: everything that determines the search's inputs.
export function counterofferCallDigest(args: {
  base: SearchBase;
  readings: SearchReading[];
  model: string;
}): string {
  return digestValue({
    base: args.base,
    inputs: args.readings.map((r) => ({ id: r.id, input: r.rawInput })),
    model: args.model,
    systemPrompt: COUNTEROFFER_SYSTEM_PROMPT,
    schema: PROPOSAL_SCHEMA,
  });
}

// The digest for the client-reply follow-up search: the same inputs as the
// main search plus the seed record and the reply-specific prompt text.
export function clientReplyCallDigest(args: {
  base: SearchBase;
  readings: SearchReading[];
  seed: SearchCandidateRecord;
  model: string;
  systemPromptSuffix: string;
}): string {
  return digestValue({
    base: args.base,
    inputs: args.readings.map((r) => ({ id: r.id, input: r.rawInput })),
    seed: args.seed,
    model: args.model,
    systemPrompt: COUNTEROFFER_SYSTEM_PROMPT + args.systemPromptSuffix,
    schema: PROPOSAL_SCHEMA,
  });
}

// The worker batch for one compiled candidate: one job per reading (as-signed
// rules plus the candidate's escrow rules) and the local digest map used to
// verify the worker's result digests.
function buildCandidateJobs(
  base: SearchBase,
  readings: SearchReading[],
  record: SearchCandidateRecord,
  compiled: CompileOk,
): { jobs: WorkerJob[]; localDigests: Map<string, string> } {
  const escrowIds = new Set(base.rules.map((r) => r.id));
  const jobs: WorkerJob[] = readings.map((reading) => {
    const asSigned = reading.rawInput.candidates[0];
    const nonEscrow = (asSigned?.paymentRules ?? []).filter((r) => !escrowIds.has(r.id));
    return {
      jobId: `${record.id}@${reading.id}`,
      input: {
        ...reading.rawInput,
        candidates: [
          {
            id: record.id,
            rankCents: compiled.rankCents,
            totalCents: asSigned?.totalCents ?? 0,
            paymentRules: [...compiled.escrowRules, ...nonEscrow],
          },
        ],
      },
    };
  });
  return {
    jobs,
    localDigests: new Map(jobs.map((j) => [j.jobId, digestValue(j.input)])),
  };
}

// Re-verifies a carried-forward best candidate: recompile the same lever, run
// it once on the first worker for both readings, and require the worker's
// result digests to match the previous run's records.
export async function reverifyBestCandidate(args: {
  base: SearchBase;
  readings: SearchReading[];
  record: SearchCandidateRecord;
  pool: WorkerPool;
}): Promise<
  | { ok: true; worker: string }
  | { ok: false; reason: "carried_search_mismatch" | "workers_unavailable"; detail: string }
> {
  const { base, readings, record, pool } = args;
  const worker = pool.workers[0];
  if (worker === undefined) {
    return {
      ok: false,
      reason: "workers_unavailable",
      detail: "the worker pool has no workers",
    };
  }
  const compiled = compileCandidate(base, {
    lever: record.lever,
    amount_cents: record.params.amount_cents,
    date: record.params.date,
    split_count: record.params.split_count,
    net_days: record.params.net_days,
    rationale: record.rationale,
  });
  if (!compiled.ok) {
    return {
      ok: false,
      reason: "carried_search_mismatch",
      detail: `carried candidate ${record.id} no longer compiles: ${compiled.detail}`,
    };
  }
  const { jobs, localDigests } = buildCandidateJobs(base, readings, record, compiled);
  let results: WorkerJobResult[];
  try {
    results = await pool.runBatch(worker, jobs);
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      return { ok: false, reason: "workers_unavailable", detail: error.message };
    }
    throw error;
  }
  for (const reading of readings) {
    const jobId = `${record.id}@${reading.id}`;
    const result = results.find((r) => r.jobId === jobId);
    if (result === undefined) {
      return {
        ok: false,
        reason: "workers_unavailable",
        detail: `worker returned no result for ${jobId}`,
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        reason: "carried_search_mismatch",
        detail: `carried candidate ${record.id} rejected by the runner on ${reading.id}: ${result.message}`,
      };
    }
    if (
      result.output.runnerVersion !== RUNNER_VERSION ||
      result.output.inputDigest !== localDigests.get(jobId)
    ) {
      return {
        ok: false,
        reason: "carried_search_mismatch",
        detail: `worker output for ${jobId} does not match the coordinator's input digest`,
      };
    }
    if (result.output.resultDigest !== record.resultDigests?.[reading.id]) {
      return {
        ok: false,
        reason: "carried_search_mismatch",
        detail: `result digest for ${jobId} differs from the carried record`,
      };
    }
  }
  return { ok: true, worker };
}

// The reply-search addendum: the main search's system prompt is unchanged;
// the follow-up search gets this appended (and the digest covers it).
export const CLIENT_REPLY_PROMPT_SUFFIX =
  "\n\nThis search answers the client's reply. clientCounter is the change the client proposed and the runner's result for it; it is already included in testedBrackets and failed at least one scenario. Look for the smallest passing change as before; when the client's lever can work, narrow that lever first so the response stays close to what the client offered.";

// Tests the client's proposed candidate on every pool worker at once: the
// same compile and job construction as a search round, but each worker runs
// both readings and all workers must agree on every result digest.
export async function testClientCandidate(args: {
  base: SearchBase;
  readings: SearchReading[];
  record: SearchCandidateRecord;
  pool: WorkerPool;
}): Promise<
  | { ok: true; record: SearchCandidateRecord; workers: string[] }
  | { ok: false; reason: string; detail: string }
> {
  const { base, readings, record, pool } = args;
  const workers = [...pool.workers];
  if (workers.length < 2) {
    return {
      ok: false,
      reason: "workers_unavailable",
      detail: `the client reply test needs at least 2 workers, the pool has ${workers.length}`,
    };
  }
  const compiled = compileCandidate(base, {
    lever: record.lever,
    amount_cents: record.params.amount_cents,
    date: record.params.date,
    split_count: record.params.split_count,
    net_days: record.params.net_days,
    rationale: record.rationale,
  });
  if (!compiled.ok) {
    return { ok: false, reason: compiled.code, detail: compiled.detail };
  }
  record.rankCents = compiled.rankCents;
  record.centDays = compiled.centDays;
  record.summary = compiled.summary;

  const { jobs, localDigests } = buildCandidateJobs(base, readings, record, compiled);

  let perWorker: [string, WorkerJobResult[]][];
  try {
    perWorker = await Promise.all(
      workers.map(async (worker) => [worker, await pool.runBatch(worker, jobs)] as const),
    );
  } catch (error) {
    if (error instanceof WorkerUnavailableError) {
      return { ok: false, reason: "workers_unavailable", detail: error.message };
    }
    throw error;
  }

  // Every worker must return a valid, digest-matching, identical result.
  const agreed = new Map<string, string>();
  for (const [worker, results] of perWorker) {
    for (const reading of readings) {
      const jobId = `${record.id}@${reading.id}`;
      const result = results.find((r) => r.jobId === jobId);
      if (result === undefined) {
        return {
          ok: false,
          reason: "workers_unavailable",
          detail: `worker ${worker} returned no result for ${jobId}`,
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          reason: result.code,
          detail: `worker ${worker}: ${result.message}`,
        };
      }
      const output = result.output;
      if (
        output.runnerVersion !== RUNNER_VERSION ||
        output.inputDigest !== localDigests.get(jobId)
      ) {
        return {
          ok: false,
          reason: "worker_digest_mismatch",
          detail: `worker ${worker} output for ${jobId} does not match the coordinator's input digest`,
        };
      }
      const seen = agreed.get(reading.id);
      if (seen === undefined) {
        agreed.set(reading.id, output.resultDigest);
      } else if (seen !== output.resultDigest) {
        return {
          ok: false,
          reason: "worker_disagreement",
          detail: `worker ${worker} resultDigest for ${jobId} differs from another worker's`,
        };
      }
    }
  }

  const firstResults = perWorker[0]?.[1] ?? [];
  record.perScenario = {};
  record.inputDigests = {};
  record.resultDigests = {};
  for (const reading of readings) {
    const result = firstResults.find((r) => r.jobId === `${record.id}@${reading.id}`);
    if (result === undefined || !result.ok) continue; // checked above
    const perScenario: Record<string, CompactResult> = {};
    for (const [scenarioId, scenarioResult] of Object.entries(
      result.output.results[record.id] ?? {},
    )) {
      perScenario[scenarioId] = compact(scenarioResult);
    }
    record.perScenario[reading.id] = perScenario;
    record.inputDigests[reading.id] = result.output.inputDigest;
    record.resultDigests[reading.id] = result.output.resultDigest;
  }
  record.passesAll = readings.every((reading) =>
    reading.rawInput.scenarios.every(
      (scen) => record.perScenario?.[reading.id]?.[scen.id]?.passes === true,
    ),
  );
  record.workers = workers;
  return { ok: true, record, workers };
}
