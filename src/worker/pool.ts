import { isRecord } from "../shape.ts";
import type { RunOutput } from "../runner/types.ts";
import { runBatchJobs } from "./run-batch.ts";

export type WorkerJob = { jobId: string; input: unknown };

export type WorkerJobResult =
  | { jobId: string; ok: true; output: RunOutput }
  | { jobId: string; ok: false; code: string; field?: string; message: string };

export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

// A retryable failure: the worker sprite is still waking up (the gateway
// answers 502/503, or the connection itself fails). Everything else is
// non-retryable and keeps the old try-twice behavior.
class ColdStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColdStartError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const COLD_START_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface WorkerPool {
  readonly workers: readonly string[];
  runBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

// Reaches each worker's run-batch endpoint through that worker's own Custom
// API connector: gateways maps the worker's display name (caveat-wa) to its
// connector's gateway base URL. The connector holds the token; requests carry
// no Authorization header here.
export class SpritesHttpPool implements WorkerPool {
  readonly workers: readonly string[];
  private readonly gateways: Map<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(args: {
    gateways: Record<string, string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.gateways = new Map(
      Object.entries(args.gateways).map(([worker, url]) => [
        worker,
        url.replace(/\/+$/, ""),
      ]),
    );
    this.workers = [...this.gateways.keys()];
    this.fetchImpl = args.fetch ?? fetch;
    this.timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleepImpl = args.sleep ?? sleep;
  }

  // Cold-starting workers get up to ~30 s of backoff (1+2+4+8+15) before the
  // batch is given up; any other failure keeps the old try-twice behavior.
  async runBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]> {
    const errors: string[] = [];
    let backoffsUsed = 0;
    for (;;) {
      try {
        return await this.tryBatch(worker, jobs, signal);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if (
          error instanceof ColdStartError &&
          backoffsUsed < COLD_START_BACKOFFS_MS.length
        ) {
          await this.sleepImpl(COLD_START_BACKOFFS_MS[backoffsUsed]!);
          backoffsUsed += 1;
          continue;
        }
        if (!(error instanceof ColdStartError) && errors.length === 1) continue;
        break;
      }
    }
    throw new WorkerUnavailableError(
      `worker ${worker} failed ${errors.length} times: ${errors.join("; ")}`,
    );
  }

  private async tryBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]> {
    const base = this.gateways.get(worker);
    if (base === undefined) {
      throw new WorkerUnavailableError(`no connector configured for worker ${worker}`);
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal =
      signal !== undefined ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/run-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobs }),
        signal: requestSignal,
      });
    } catch (error) {
      // The caller cancelled — never retry.
      if (error instanceof Error && error.name === "AbortError") {
        throw new WorkerUnavailableError(`run-batch aborted: ${error.message}`);
      }
      // TimeoutError and transport failures are cold-start symptoms too: a
      // waking sprite's gateway hangs the request instead of answering 502.
      throw new ColdStartError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok) {
      if (response.status === 502 || response.status === 503) {
        throw new ColdStartError(`run-batch returned HTTP ${response.status}`);
      }
      throw new WorkerUnavailableError(`run-batch returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new WorkerUnavailableError("run-batch response was not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.runnerVersion !== "string" ||
      !Array.isArray(parsed.results) ||
      !parsed.results.every(
        (r) => isRecord(r) && typeof r.jobId === "string" && typeof r.ok === "boolean",
      )
    ) {
      throw new WorkerUnavailableError("run-batch response lacked {runnerVersion, results}");
    }
    return parsed.results as WorkerJobResult[];
  }
}

// In-process pool for tests only — production never falls back to it. Multiple
// worker names are allowed so distribution can be exercised.
export class InProcessPool implements WorkerPool {
  readonly workers: readonly string[];
  private readonly jobsByWorker: Map<string, WorkerJob[]>;
  readonly calls: { worker: string; jobs: WorkerJob[] }[];

  constructor(workers: readonly string[] = ["local"]) {
    this.workers = workers;
    this.jobsByWorker = new Map();
    this.calls = [];
  }

  runBatch(worker: string, jobs: WorkerJob[]): Promise<WorkerJobResult[]> {
    this.calls.push({ worker, jobs });
    this.jobsByWorker.set(worker, jobs);
    return Promise.resolve(runBatchJobs(jobs).results as WorkerJobResult[]);
  }
}
