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

export interface WorkerPool {
  readonly workers: readonly string[];
  runBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]>;
}

// Exec stream framing probed against the live API (see pool.test.ts): each
// frame is one tag byte followed by raw payload up to the next tag — 0x01
// stdout, 0x02 stderr, 0x03 then one exit-code byte. There is no length field;
// the writer splits chunks wherever it flushes (~32 KiB observed). JSON stdout
// never contains raw tag bytes, so the scan is unambiguous for our payloads.
export type ExecStream = {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number | null;
};

const TAG_STDOUT = 0x01;
const TAG_STDERR = 0x02;
const TAG_EXIT = 0x03;

export function parseExecStream(buf: Uint8Array): ExecStream {
  const stdout: number[] = [];
  const stderr: number[] = [];
  let exitCode: number | null = null;
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i] ?? 0;
    i += 1;
    if (tag === TAG_EXIT) {
      if (i < buf.length) {
        exitCode = buf[i] ?? null;
      }
      break;
    }
    if (tag !== TAG_STDOUT && tag !== TAG_STDERR) {
      // Untagged byte: treat as trailing stdout noise rather than corrupt the
      // whole stream — the exit frame still terminates parsing.
      (stdout).push(tag);
      continue;
    }
    const sink = tag === TAG_STDOUT ? stdout : stderr;
    while (i < buf.length && buf[i] !== TAG_STDOUT && buf[i] !== TAG_STDERR && buf[i] !== TAG_EXIT) {
      sink.push(buf[i] ?? 0);
      i += 1;
    }
  }
  return { stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr), exitCode };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const WORKER_DIR = "/home/sprite/caveat-worker";
const NODE_BIN = "/.sprite/bin/node";

export class SpritesExecPool implements WorkerPool {
  readonly workers: readonly string[];
  private readonly gatewayBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(args: {
    gatewayBaseUrl: string;
    workers: readonly string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.gatewayBaseUrl = args.gatewayBaseUrl.replace(/\/+$/, "");
    this.workers = args.workers;
    this.fetchImpl = args.fetch ?? fetch;
    this.timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async runBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]> {
    const errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.tryBatch(worker, jobs, signal);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new WorkerUnavailableError(
      `worker ${worker} failed twice: ${errors.join("; ")}`,
    );
  }

  private async tryBatch(worker: string, jobs: WorkerJob[], signal?: AbortSignal): Promise<WorkerJobResult[]> {
    const url =
      `${this.gatewayBaseUrl}/v1/sprites/${encodeURIComponent(worker)}/exec` +
      `?cmd=${encodeURIComponent(NODE_BIN)}` +
      `&cmd=${encodeURIComponent(`${WORKER_DIR}/src/worker/run-batch.ts`)}` +
      `&stdin=true&dir=${encodeURIComponent(WORKER_DIR)}`;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal =
      signal !== undefined ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: JSON.stringify({ jobs }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new WorkerUnavailableError(`exec returned HTTP ${response.status}`);
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    const stream = parseExecStream(buf);
    if (stream.exitCode === null) {
      throw new WorkerUnavailableError("exec stream had no exit frame");
    }
    if (stream.exitCode !== 0) {
      const errText = new TextDecoder().decode(stream.stderr).slice(0, 300);
      throw new WorkerUnavailableError(
        `exec exited ${stream.exitCode}${errText.length > 0 ? `: ${errText}` : ""}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(stream.stdout));
    } catch {
      throw new WorkerUnavailableError("exec stdout was not valid JSON");
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
      throw new WorkerUnavailableError("exec stdout lacked a results array");
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
