import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture } from "../runner/run.ts";
import type { ScenarioResult } from "../runner/types.ts";
import type { ValidatedSchedule } from "../interpret/schedule.ts";
import type { RetainerReview } from "../review/human-review.ts";
import { buildTwinveeInputs, escrowRules } from "../plan/twinvee.ts";
import type { TwinveeAssumptions } from "../plan/twinvee.ts";
import type { ChatResult, StructuredChatConfig } from "../interpret/chat.ts";
import type { callStructuredChat } from "../interpret/chat.ts";
import { InProcessPool } from "../worker/pool.ts";
import type { WorkerJob, WorkerJobResult, WorkerPool } from "../worker/pool.ts";
import { buildSearchBase } from "./levers.ts";
import { runCounterofferSearch } from "./loop.ts";
import type { SearchReading } from "./loop.ts";


// Explicit comparator: the same UTF-16 code-unit order as .sort().
const BY_STRING = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const ASSUMPTIONS = loadJson(
  "../../fixtures/plan/twinvee-demo-assumptions.json",
) as TwinveeAssumptions;

const EXTRACTION: ValidatedSchedule = {
  monthlyAmountText: "$25,000",
  monthlyAmountCents: 2500000,
  monthlyExcerptId: "03-second-amendment.pdf#§3(a)",
  monthlyQuote: "The Company shall pay Consultant $25,000 per month.",
  periodText: "6-month",
  periodMonths: 6,
  periodExcerptId: "03-second-amendment.pdf#§3(b)",
  periodQuote: "escrow for the 6-month period",
  releases: [
    {
      id: "release-1",
      conditional: false,
      extensionId: undefined,
      amountText: "$75,000",
      amountCents: 7500000,
      dateText: "January 2, 2027",
      date: "2027-01-02",
      conditionText: null,
      excerptId: "03-second-amendment.pdf#§3(b)(i)",
      quote: "$75,000 shall be paid to Consultant on January 2, 2027",
    },
    {
      id: "release-ext-1",
      conditional: true,
      extensionId: "ext-2027-01-31",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "January 2, 2027",
      date: "2027-01-02",
      conditionText: "until January 31, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(ii)",
      quote: "$25,000 shall be paid to Consultant on January 2, 2027",
    },
    {
      id: "release-ext-2",
      conditional: true,
      extensionId: "ext-2027-02-28",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "February 2, 2027",
      date: "2027-02-02",
      conditionText: "until February 28, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(iii)",
      quote: "$25,000 shall be paid to Consultant on February 2, 2027",
    },
    {
      id: "release-ext-3",
      conditional: true,
      extensionId: "ext-2027-03-31",
      amountText: "$25,000",
      amountCents: 2500000,
      dateText: "March 2, 2027",
      date: "2027-03-02",
      conditionText: "until March 31, 2027",
      excerptId: "03-second-amendment.pdf#§3(b)(iv)",
      quote: "$25,000 shall be paid to Consultant on March 2, 2027",
    },
  ],
  confidence: 0.9,
};

const REVIEW: RetainerReview = {
  questionId: "retainer_after_second_amendment",
  reviewer: "Ololade Stephen",
  reviewedAt: "2026-11-24",
  revision: 2,
  revisionNote: "Corrects revision 1.",
  baseRetainer: {
    answer: "unresolved_compare_both",
    note: "comparing both readings",
    citations: [],
    continuesReading: {
      amount: {
        text: "$6,000 per month",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.3",
        quote: "a rate of $6,000 per month",
      },
      payDay: {
        text: "on the 1st of each month",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.4",
        quote: "on the 1st of each month",
      },
      termEnd: {
        text: "December 31, 2026",
        fileName: "01-consulting-agreement.pdf",
        section: "§1.5",
        quote: "expire on December 31, 2026",
      },
    },
  },
  firstAmendmentPay: {
    answer: "continues",
    cashEffectInWindow: "none",
    note: "no cash in window",
    citations: [],
  },
};

const BASE = buildSearchBase(
  EXTRACTION,
  escrowRules(EXTRACTION, ASSUMPTIONS.escrowFundingDate),
  ASSUMPTIONS.escrowFundingDate,
);

const INPUTS = buildTwinveeInputs({
  schedule: EXTRACTION,
  review: REVIEW,
  assumptions: ASSUMPTIONS,
});

function readings(): SearchReading[] {
  return Object.entries(INPUTS).map(([id, rawInput]) => ({
    id,
    label: id,
    rawInput: rawInput as SearchReading["rawInput"],
    asSignedResults: runFixture(rawInput).results["as_signed"] ?? {},
  }));
}

const CHAT_CONFIG: StructuredChatConfig = { gatewayBaseUrl: "https://stub", timeoutMs: 1000 };

type RawCandidate = {
  lever: string;
  amount_cents?: number | null;
  date?: string | null;
  split_count?: number | null;
  net_days?: number | null;
  rationale?: string;
};

function emit(parsed: unknown): ChatResult {
  return { ok: true, parsed, modelVersion: "test-v1", latencyMs: 1 };
}

function proposal(candidates: RawCandidate[], done: boolean, note = "note"): ChatResult {
  return emit({
    round_note: note,
    done,
    candidates: candidates.map((c) => ({
      lever: c.lever,
      amount_cents: c.amount_cents ?? null,
      date: c.date ?? null,
      split_count: c.split_count ?? null,
      net_days: c.net_days ?? null,
      rationale: c.rationale ?? "why",
    })),
  });
}

// A chat stub that replays a script; each entry is a ChatResult or a function
// of the call number. Calls past the script fail loudly.
function scriptedChat(script: (ChatResult | (() => ChatResult))[]): {
  chat: typeof callStructuredChat;
  calls: { userPrompt: string }[];
} {
  const calls: { userPrompt: string }[] = [];
  const chat = ((_config: unknown, request: { userPrompt: string }) => {
    calls.push({ userPrompt: request.userPrompt });
    const entry = script[calls.length - 1];
    if (entry === undefined) throw new Error(`chat called ${calls.length} times; script exhausted`);
    return Promise.resolve(typeof entry === "function" ? entry() : entry);
  }) as typeof callStructuredChat;
  return { chat, calls };
}

const DEPOSIT_8K: RawCandidate = {
  lever: "upfront_deposit",
  amount_cents: 800000,
  date: "2026-10-01",
};
const DEPOSIT_1: RawCandidate = { lever: "upfront_deposit", amount_cents: 100, date: "2026-10-01" };

describe("runCounterofferSearch", () => {
  it("returns not_needed without calling the model when both readings already pass", async () => {
    const passing: ScenarioResult = {
      passes: true,
      firstBreach: null,
      lowest: { date: "2027-01-15", balanceCents: 5000000 },
      endBalanceCents: 5000000,
      endEscrowCents: 0,
      ledger: [],
    };
    const rs = readings().map((r) => ({
      ...r,
      asSignedResults: { no_extensions: passing, all_extensions: passing },
    }));
    const { chat, calls } = scriptedChat([]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: rs,
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
    });
    expect(result.status).toBe("not_needed");
    expect(result.rounds).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("finds a passing candidate and stops on done", async () => {
    const { chat } = scriptedChat([proposal([DEPOSIT_8K], true, "try a deposit")]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa", "caveat-wb"]),
      chat,
    });
    expect(result.status).toBe("found");
    expect(result.stopReason).toBe("model_done");
    expect(result.best).toBe("r1c1");
    const best = result.rounds[0]?.candidates[0];
    expect(best?.status).toBe("tested");
    expect(best?.passesAll).toBe(true);
    expect(best?.rankCents).toBe(800000);
    expect(Object.keys(best?.perScenario ?? {})).toHaveLength(2);
    expect(result.humanReview).toHaveLength(0);
  });

  it("caps at 4 rounds with stopReason round_cap", async () => {
    const EARLY_1: RawCandidate = { lever: "earlier_release", amount_cents: 100, date: "2026-11-13" };
    const { chat, calls } = scriptedChat([
      proposal([DEPOSIT_1, EARLY_1], false),
      proposal([DEPOSIT_1, EARLY_1], false),
      proposal([DEPOSIT_1, EARLY_1], false),
      proposal([DEPOSIT_1, EARLY_1], false),
    ]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
      maxRounds: 4,
    });
    expect(result.status).toBe("not_found");
    expect(result.stopReason).toBe("round_cap");
    expect(result.rounds).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });

  it("picks the smallest rankCents, ties on centDays then order", async () => {
    // All three pass; best is the smallest rank, then smallest centDays.
    const early900Nov13: RawCandidate = { lever: "earlier_release", amount_cents: 900000, date: "2026-11-13" };
    const early800: RawCandidate = { lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" };
    const { chat } = scriptedChat([
      proposal([early900Nov13, { lever: "upfront_deposit", amount_cents: 5000000, date: "2026-10-01" }], false),
      proposal([{ lever: "upfront_deposit", amount_cents: 900000, date: "2026-10-01" }, early800], true),
    ]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa", "caveat-wb"]),
      chat,
    });
    expect(result.status).toBe("found");
    // $8,000 < $9,000 regardless of when it lands.
    expect(result.best).toBe("r2c2");
    const best = result.rounds.flatMap((r) => r.candidates).find((c) => c.id === "r2c2");
    expect(best?.rankCents).toBe(800000);
  });

  it("marks compile rejections as rejected_malformed and still runs siblings", async () => {
    const malformed: RawCandidate = { lever: "earlier_release", amount_cents: null, date: "2026-11-13" };
    const { chat } = scriptedChat([proposal([malformed, DEPOSIT_8K], true)]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
    });
    expect(result.status).toBe("found");
    const bad = result.rounds[0]?.candidates[0];
    expect(bad?.status).toBe("rejected_malformed");
    expect(bad?.rejection).toMatchObject({ by: "compile", code: "missing_field" });
    expect(result.humanReview).toEqual(["r1c1"]);
    expect(result.best).toBe("r1c2");
  });

  it("marks runner invalid_input as rejected_malformed by the runner", async () => {
    // A reading whose non-escrow rules already use the id "deposit": a deposit
    // candidate then emits a duplicate id and the runner rejects the job.
    const rs = readings().map((r) => {
      if (r.id !== "retainer_continues") return r;
      const raw = JSON.parse(JSON.stringify(r.rawInput)) as SearchReading["rawInput"];
      raw.candidates[0]!.paymentRules.push({
        id: "deposit",
        kind: "on_date",
        amountCents: 100,
        date: "2026-10-01",
      });
      raw.candidates[0]!.totalCents += 100;
      return { ...r, rawInput: raw };
    });
    const { chat } = scriptedChat([proposal([DEPOSIT_8K], true)]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: rs,
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
    });
    const bad = result.rounds[0]?.candidates[0];
    expect(bad?.status).toBe("rejected_malformed");
    expect(bad?.rejection).toMatchObject({ by: "runner", code: "invalid_input" });
    expect(result.humanReview).toEqual(["r1c1"]);
  });

  it("reuses earlier results for duplicate compiled rules", async () => {
    const { chat } = scriptedChat([
      proposal([
        DEPOSIT_8K,
        { lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" },
      ], false),
      proposal([{ ...DEPOSIT_8K, rationale: "same again" }], true),
    ]);
    const pool = new InProcessPool(["caveat-wa", "caveat-wb"]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool,
      chat,
    });
    const dup = result.rounds[1]?.candidates[0];
    expect(dup?.status).toBe("duplicate");
    expect(dup?.duplicateOf).toBe("r1c1");
    expect(dup?.passesAll).toBe(true);
    // Round 1 ran both candidates (one batch per worker); the duplicate in
    // round 2 ran nothing.
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0]?.jobs).toHaveLength(2);
    expect(pool.calls[1]?.jobs).toHaveLength(2);
  });

  it("returns needs_review on a model failure and keeps earlier rounds", async () => {
    const { chat } = scriptedChat([
      proposal([
        DEPOSIT_8K,
        { lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" },
      ], false, "round one"),
      { ok: false, reason: "rate_limited", detail: "429" },
    ]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
    });
    expect(result.status).toBe("needs_review");
    expect(result.stopReason).toBe("model_error");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.candidates[0]?.passesAll).toBe(true);
  });

  it("returns needs_review when the proposal fails schema validation", async () => {
    const { chat } = scriptedChat([emit({ round_note: "", done: true, candidates: [] })]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa"]),
      chat,
    });
    expect(result.status).toBe("needs_review");
    expect(result.stopReason).toBe("model_error");
    expect(result.reason).toBe("schema_mismatch");
  });

  it("returns needs_review on a worker digest mismatch", async () => {
    class CorruptingPool implements WorkerPool {
      readonly workers = ["caveat-wa"];
      private readonly inner = new InProcessPool(["caveat-wa"]);
      async runBatch(worker: string, jobs: WorkerJob[]): Promise<WorkerJobResult[]> {
        const results = await this.inner.runBatch(worker, jobs);
        return results.map((r) =>
          r.ok ? { ...r, output: { ...r.output, inputDigest: "forged" } } : r,
        );
      }
    }
    const { chat } = scriptedChat([proposal([DEPOSIT_8K], true)]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new CorruptingPool(),
      chat,
    });
    expect(result.status).toBe("needs_review");
    expect(result.stopReason).toBe("worker_error");
    expect(result.reason).toBe("worker_digest_mismatch");
  });

  it("returns needs_review when a worker is unavailable", async () => {
    class DeadPool implements WorkerPool {
      readonly workers = ["caveat-wa"];
      async runBatch(): Promise<WorkerJobResult[]> {
        const { WorkerUnavailableError } = await import("../worker/pool.ts");
        throw new WorkerUnavailableError("exec failed");
      }
    }
    const { chat } = scriptedChat([proposal([DEPOSIT_8K], true)]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new DeadPool(),
      chat,
    });
    expect(result.status).toBe("needs_review");
    expect(result.reason).toBe("workers_unavailable");
  });

  it("distributes candidates across both workers in the same round", async () => {
    const second: RawCandidate = { lever: "earlier_release", amount_cents: 800000, date: "2026-11-13" };
    const third: RawCandidate = { lever: "milestone_split", amount_cents: 800000, date: "2026-11-13", split_count: 2 };
    const { chat } = scriptedChat([proposal([DEPOSIT_8K, second, third], true)]);
    const pool = new InProcessPool(["caveat-wa", "caveat-wb"]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool,
      chat,
    });
    expect(result.status).toBe("found");
    // Three candidates round-robin: wa gets r1c1+r1c3, wb gets r1c2.
    expect(pool.calls).toHaveLength(2);
    const [wa, wb] = pool.calls;
    expect(wa?.worker).toBe("caveat-wa");
    expect(wb?.worker).toBe("caveat-wb");
    expect(wa?.jobs.map((j) => j.jobId).sort(BY_STRING)).toEqual([
      "r1c1@retainer_continues",
      "r1c1@retainer_superseded",
      "r1c3@retainer_continues",
      "r1c3@retainer_superseded",
    ]);
    expect(wb?.jobs.map((j) => j.jobId).sort(BY_STRING)).toEqual([
      "r1c2@retainer_continues",
      "r1c2@retainer_superseded",
    ]);
    expect(result.rounds[0]?.candidates[0]?.worker).toBe("caveat-wa");
    expect(result.rounds[0]?.candidates[1]?.worker).toBe("caveat-wb");
  });
});

// --- testedBrackets -----------------------------------------------------------

import { testedBrackets } from "./loop.ts";
import type { Lever } from "./levers.ts";
import type { SearchCandidateRecord } from "./loop.ts";
import { digestValue } from "../runner/digest.ts";
import { RUNNER_VERSION } from "../runner/run.ts";

function rec(
  id: string,
  lever: Lever,
  params: SearchCandidateRecord["params"],
  verdict: boolean,
  status: "tested" | "duplicate" = "tested",
): SearchCandidateRecord {
  const r: SearchCandidateRecord = {
    id,
    lever,
    params,
    rationale: "x",
    status,
    rankCents: params.amount_cents ?? 0,
  };
  if (status === "tested") r.passesAll = verdict;
  return r;
}

describe("testedBrackets", () => {
  it("picks the smallest pass and the closest smaller fail per family", () => {
    const brackets = testedBrackets([
      rec("p800", "upfront_deposit", { amount_cents: 800000, date: "2026-10-01", split_count: null, net_days: null }, true),
      rec("f700", "upfront_deposit", { amount_cents: 700000, date: "2026-10-01", split_count: null, net_days: null }, false),
      rec("f750", "upfront_deposit", { amount_cents: 750000, date: "2026-10-01", split_count: null, net_days: null }, false),
      rec("p900", "upfront_deposit", { amount_cents: 900000, date: "2026-10-01", split_count: null, net_days: null }, true),
    ]);
    expect(brackets).toHaveLength(1);
    expect(brackets[0]?.smallestPass?.id).toBe("p800");
    expect(brackets[0]?.largestFail?.id).toBe("f750");
  });

  it("treats a larger net_days as a smaller change for shorter_payment_terms", () => {
    const brackets = testedBrackets([
      rec("n20p", "shorter_payment_terms", { amount_cents: null, date: null, split_count: null, net_days: 20 }, true),
      rec("n25f", "shorter_payment_terms", { amount_cents: null, date: null, split_count: null, net_days: 25 }, false),
    ]);
    expect(brackets[0]?.smallestPass?.id).toBe("n20p");
    expect(brackets[0]?.largestFail?.id).toBe("n25f");
  });

  it("keeps families apart by date and takes the largest fail when nothing passed", () => {
    const brackets = testedBrackets([
      rec("a", "upfront_deposit", { amount_cents: 800000, date: "2026-10-01", split_count: null, net_days: null }, true),
      rec("b", "upfront_deposit", { amount_cents: 700000, date: "2026-11-01", split_count: null, net_days: null }, false),
      rec("c", "upfront_deposit", { amount_cents: 600000, date: "2026-11-01", split_count: null, net_days: null }, false),
    ]);
    expect(brackets).toHaveLength(2);
    const nov = brackets.find((b) => b.date === "2026-11-01");
    expect(nov?.smallestPass).toBeNull();
    expect(nov?.largestFail?.id).toBe("b");
  });

  it("counts a duplicate once, under its original", () => {
    const brackets = testedBrackets([
      rec("p800", "upfront_deposit", { amount_cents: 800000, date: "2026-10-01", split_count: null, net_days: null }, true),
      rec("f700", "upfront_deposit", { amount_cents: 700000, date: "2026-10-01", split_count: null, net_days: null }, false),
      { ...rec("dup", "upfront_deposit", { amount_cents: 800000, date: "2026-10-01", split_count: null, net_days: null }, false, "duplicate"), duplicateOf: "p800" },
    ]);
    expect(brackets).toHaveLength(1);
    expect(brackets[0]?.smallestPass?.id).toBe("p800");
    expect(brackets[0]?.largestFail?.id).toBe("f700");
  });
});

// --- parallel rounds + the tested bound ----------------------------------------

// A pool that returns scripted verdicts; the real inputDigest is echoed so the
// loop's coordinator-side digest check still passes.
class VerdictPool implements WorkerPool {
  readonly workers = ["caveat-wa", "caveat-wb"];
  readonly calls: { worker: string; jobs: WorkerJob[] }[] = [];
  private readonly verdicts: Record<string, boolean>;
  constructor(verdicts: Record<string, boolean>) {
    this.verdicts = verdicts;
  }
  runBatch(worker: string, jobs: WorkerJob[]): Promise<WorkerJobResult[]> {
    this.calls.push({ worker, jobs });
    return Promise.resolve(
      jobs.map((job) => {
        const candId = job.jobId.split("@")[0] ?? job.jobId;
        const pass = this.verdicts[candId] === true;
        const scenario = {
          passes: pass,
          firstBreach: pass ? null : { date: "2026-12-15", week: 11, balanceCents: 900000 },
          lowest: { date: "2026-12-15", balanceCents: pass ? 1000000 : 900000 },
          endBalanceCents: 0,
          endEscrowCents: 0,
          ledger: [],
        };
        return {
          jobId: job.jobId,
          ok: true as const,
          output: {
            runnerVersion: RUNNER_VERSION,
            inputDigest: digestValue(job.input),
            results: { [candId]: { no_extensions: scenario, all_extensions: scenario } },
            smallestPassingCandidate: pass ? candId : null,
            resultDigest: digestValue(job.input),
          },
        };
      }),
    );
  }
}

describe("parallel bracket-narrowing search", () => {
  it("tests distinct levers on both workers per round and reports the bound", async () => {
    const release = (amount: number): RawCandidate => ({
      lever: "earlier_release",
      amount_cents: amount,
      date: "2026-11-13",
    });
    const { chat, calls } = scriptedChat([
      proposal([DEPOSIT_8K, release(800000)], false),
      proposal([
        { lever: "upfront_deposit", amount_cents: 750000, date: "2026-10-01" },
        release(700000),
      ], true),
    ]);
    const pool = new VerdictPool({ r1c1: true, r1c2: false, r2c1: false, r2c2: false });
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool,
      chat,
    });
    expect(result.status).toBe("found");
    // Round 1's two candidates ran in parallel, one batch per worker.
    const round1Calls = pool.calls.slice(0, 2);
    expect(round1Calls.map((c) => c.worker).sort(BY_STRING)).toEqual(["caveat-wa", "caveat-wb"]);
    // The prompt for round 2 carried the round-1 bracket.
    const prompt2 = JSON.parse(calls[1]?.userPrompt ?? "{}") as {
      testedBrackets?: { lever: string; smallestPass: { id: string } | null; largestFail: { id: string } | null }[];
    };
    const deposit = prompt2.testedBrackets?.find((b) => b.lever === "upfront_deposit");
    expect(deposit?.smallestPass?.id).toBe("r1c1");
    expect(deposit?.largestFail).toBeNull();
    const rel = prompt2.testedBrackets?.find((b) => b.lever === "earlier_release");
    expect(rel?.smallestPass).toBeNull();
    expect(rel?.largestFail?.id).toBe("r1c2");
    // The best is bracketed by the closest failing deposit below it.
    expect(result.best).toBe("r1c1");
    expect(result.bound).toEqual({ candidate: "r2c1", gap: { unit: "cents", value: 50000 } });
  });

  it("brackets the deposit lever with real runner verdicts", async () => {
    // Hand-checked runner truth: $8,000 deposit passes; $7,900 and $7,000 fail.
    const filler = (amount: number): RawCandidate => ({
      lever: "earlier_release",
      amount_cents: amount,
      date: "2026-11-13",
    });
    const { chat } = scriptedChat([
      proposal([DEPOSIT_8K, filler(100)], false),
      proposal([{ lever: "upfront_deposit", amount_cents: 790000, date: "2026-10-01" }, filler(200)], false),
      proposal([{ lever: "upfront_deposit", amount_cents: 700000, date: "2026-10-01" }, filler(300)], true),
    ]);
    const result = await runCounterofferSearch({
      base: BASE,
      readings: readings(),
      model: "m",
      chatConfig: CHAT_CONFIG,
      pool: new InProcessPool(["caveat-wa", "caveat-wb"]),
      chat,
    });
    expect(result.status).toBe("found");
    expect(result.best).toBe("r1c1");
    expect(result.bound).toEqual({ candidate: "r2c1", gap: { unit: "cents", value: 10000 } });
  });
});
