import { digestValue } from "../runner/digest.ts";
import { RUNNER_VERSION } from "../runner/run.ts";
import type { PaymentRule, ScenarioResult } from "../runner/types.ts";
import { callStructuredChat, modelInfo } from "../interpret/chat.ts";
import type { ChatResult, StructuredChatConfig } from "../interpret/chat.ts";
import type { WorkerJob, WorkerJobResult, WorkerPool } from "../worker/pool.ts";
import { WorkerUnavailableError } from "../worker/pool.ts";
import { compileCandidate } from "./levers.ts";
import type { Lever, SearchBase } from "./levers.ts";
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

export type CounterofferReceipt = {
  status: "found" | "not_found" | "needs_review" | "not_needed";
  stopReason: SearchStopReason;
  reason?: string;
  detail?: string;
  model: string;
  rounds: SearchRound[];
  best: string | null;
  humanReview: string[];
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
    previousRounds: rounds,
  });
}

// The counteroffer search: propose -> compile -> run on workers -> repeat.
// The runner is the only source of numbers; the model only proposes.
export async function runCounterofferSearch(args: SearchArgs): Promise<CounterofferReceipt> {
  const maxRounds = args.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const chat = args.chat ?? callStructuredChat;
  const model = args.model;
  const rounds: SearchRound[] = [];
  const escrowIds = new Set(args.base.rules.map((r) => r.id));
  const seenRules = new Map<string, string>(); // rules digest -> first candidate id
  const allRecords: SearchCandidateRecord[] = [];

  // Both readings already pass as signed: nothing to search.
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

  for (let round = 1; round <= maxRounds; round += 1) {
    const chatResult: ChatResult = await chat(args.chatConfig, {
      model,
      systemPrompt: COUNTEROFFER_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt({ round, maxRounds, search: args, previousRounds: rounds }),
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
    const runnable: { record: SearchCandidateRecord; escrowRules: PaymentRule[] }[] = [];
    proposal.candidates.forEach((p, index) => {
      const record: SearchCandidateRecord = {
        id: `r${round}c${index + 1}`,
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
      const compiled = compileCandidate(args.base, p);
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

    // Build + distribute jobs ----------------------------------------------------
    const jobsByWorker = new Map<string, WorkerJob[]>();
    const localDigests = new Map<string, string>();
    runnable.forEach((candidate, i) => {
      const worker = args.pool.workers[i % args.pool.workers.length] as string;
      candidate.record.worker = worker;
      for (const reading of args.readings) {
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
          args.pool.runBatch(worker, jobs).then((results) => ({ worker, results })),
        ),
      );
      for (const { results } of settled) {
        for (const result of results) batchResults.set(result.jobId, result);
      }
    } catch (error) {
      if (error instanceof WorkerUnavailableError) {
        return receipt({
          status: "needs_review",
          stopReason: "worker_error",
          reason: "workers_unavailable",
          detail: error.message,
          model,
          rounds,
        });
      }
      throw error;
    }

    // Fold results back ----------------------------------------------------------
    for (const candidate of runnable) {
      const record = candidate.record;
      record.perScenario = {};
      record.inputDigests = {};
      record.resultDigests = {};
      for (const reading of args.readings) {
        const jobId = `${record.id}@${reading.id}`;
        const result = batchResults.get(jobId);
        if (result === undefined) {
          return receipt({
            status: "needs_review",
            stopReason: "worker_error",
            reason: "workers_unavailable",
            detail: `worker returned no result for ${jobId}`,
            model,
            rounds,
          });
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
        if (output.runnerVersion !== RUNNER_VERSION || output.inputDigest !== localDigests.get(jobId)) {
          return receipt({
            status: "needs_review",
            stopReason: "worker_error",
            reason: "worker_digest_mismatch",
            detail: `worker output for ${jobId} does not match the coordinator's input digest`,
            model,
            rounds,
          });
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
        record.passesAll = args.readings.every((reading) =>
          reading.rawInput.scenarios.every(
            (scen) => record.perScenario?.[reading.id]?.[scen.id]?.passes === true,
          ),
        );
      }
    }

    // Duplicates reuse the original's outcome. ------------------------------------
    for (const record of allRecords) {
      if (record.status !== "duplicate" || record.duplicateOf === undefined) continue;
      const original = allRecords.find((c) => c.id === record.duplicateOf);
      if (original === undefined) continue;
      // The verdicts carry over; the digests do not — this candidate's own
      // input (with its own id) was never run.
      record.passesAll = original.passesAll;
      record.perScenario = original.perScenario;
    }

    if (proposal.done) break;
  }

  const best = findBest(rounds);
  const lastRound = rounds[rounds.length - 1];
  const stopReason: SearchStopReason =
    lastRound?.done === true ? "model_done" : "round_cap";
  return receipt({
    status: best === null ? "not_found" : "found",
    stopReason,
    model,
    rounds,
    best: best?.id ?? null,
  });
}
