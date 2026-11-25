import { createServer } from "node:http";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import { isRecord } from "../shape.ts";
import { runBatchJobs } from "./run-batch.ts";
import type { BatchJob } from "./run-batch.ts";

const MAX_BODY_BYTES = 1024 * 1024;

// The worker's only surface: a health check and the runner batch endpoint,
// reached through the worker's org-private Sprite URL via its Custom API
// connector. No network calls, no secrets, no state on disk.
export function createWorkerServer(): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (method === "POST" && path === "/run-batch") {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES && !tooLarge) {
          tooLarge = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "request body too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "request body was not valid JSON" }));
          return;
        }
        const jobs =
          isRecord(body) &&
          Array.isArray(body.jobs) &&
          body.jobs.every((j) => isRecord(j) && typeof j.jobId === "string")
            ? (body.jobs as BatchJob[])
            : undefined;
        if (jobs === undefined) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "expected JSON {jobs:[{jobId,input}]}" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runBatchJobs(jobs)));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT);
  const server = createWorkerServer();
  server.listen(Number.isFinite(port) ? port : 8080, () => {
    console.log("caveat-worker listening");
  });
}
