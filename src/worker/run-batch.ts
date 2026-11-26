import { pathToFileURL } from "node:url";

import { RUNNER_VERSION, runFixture } from "../runner/run.ts";
import { RunInputError } from "../runner/validate.ts";
import type { RunOutput } from "../runner/types.ts";

export type BatchJob = { jobId: string; input: unknown };

export type BatchJobResult =
  | { jobId: string; ok: true; output: RunOutput }
  | { jobId: string; ok: false; code: string; field?: string; message: string };

export type BatchResponse = {
  runnerVersion: string;
  results: BatchJobResult[];
};

// Runs one job per entry; a validation failure is the job's answer, never a
// batch abort. Non-validation throws are reported as runner_error for the same
// reason — one bad job must not poison its siblings.
export function runBatchJobs(jobs: BatchJob[]): BatchResponse {
  const results: BatchJobResult[] = jobs.map((job) => {
    try {
      return { jobId: job.jobId, ok: true as const, output: runFixture(job.input) };
    } catch (error) {
      if (error instanceof RunInputError) {
        return {
          jobId: job.jobId,
          ok: false as const,
          code: "invalid_input",
          field: error.path,
          message: error.message,
        };
      }
      return {
        jobId: job.jobId,
        ok: false as const,
        code: "runner_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return { runnerVersion: RUNNER_VERSION, results };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// stdin: {"jobs":[{"jobId","input"}]} — stdout: exactly one JSON line.
async function main(): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(await readStdin());
  } catch {
    process.stderr.write("expected stdin JSON {jobs:[{jobId,input}]}\n");
    process.exit(2);
  }
  const jobs =
    typeof request === "object" && request !== null && Array.isArray((request as { jobs?: unknown }).jobs)
      ? ((request as { jobs: BatchJob[] }).jobs)
      : undefined;
  if (jobs === undefined) {
    process.stderr.write("expected stdin JSON {jobs:[{jobId,input}]}\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(runBatchJobs(jobs))}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
