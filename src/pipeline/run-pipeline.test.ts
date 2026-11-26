import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runPipeline } from "./run-pipeline.ts";
import type { RunReceipt } from "../review/receipt.ts";
import { InProcessPool } from "../worker/pool.ts";
import type { WorkerJob, WorkerJobResult } from "../worker/pool.ts";

const config = {
  runId: "run-test",
  reviewsDir: "reviews",
  fixturesDir: "fixtures",
};

describe("runPipeline connector checks", () => {
  it("fails fast when the box connector is missing", async () => {
    await expect(runPipeline({ ...config, connections: [] })).rejects.toThrow(
      "box connector not configured",
    );
  });

  it("fails fast when the openrouter connector is missing", async () => {
    await expect(
      runPipeline({
        ...config,
        connections: [{ provider: "box", gatewayBaseUrl: "http://127.0.0.1:1" }],
      }),
    ).rejects.toThrow("openrouter connector not configured");
  });

  it("tags failures with the failing step", async () => {
    const error = await runPipeline({ ...config, connections: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { step?: string }).step).toBe("box");
  });
});

// --- Orchestration test: canned Box REST + injected pdfText + routed chat ----

const BOX = "http://box.test";
const OR = "http://or.test";
const TS = "http://ts.test";
const CONNECTIONS = [
  { provider: "box", gatewayBaseUrl: BOX },
  { provider: "openrouter", gatewayBaseUrl: OR },
];
const TYPESAFE_CONNECTIONS = [
  ...CONNECTIONS,
  { provider: "typesafe", gatewayBaseUrl: TS },
];

const JEV_ACTION_KEYS = [
  "cash_on_fixed_date",
  "escrow_release",
  "transaction_triggered",
  "ambiguous",
];
const jevChoice = (choice: string, confidence: number, keys: string[]) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(
    keys.map((k) => [k, k === choice ? confidence : (1 - confidence) / (keys.length - 1)]),
  ),
});
const JEV_DECIDED_ANSWERS = {
  release_timing: jevChoice("escrow_release", 0.95, JEV_ACTION_KEYS),
  release_timing_source: jevChoice("e1", 0.9, ["e1"]),
};

const FILE_NAMES = [
  "01-consulting-agreement.pdf",
  "02-first-amendment.pdf",
  "03-second-amendment.pdf",
];

// The canned operative section text lives in cannedPdfLines; the model quotes
// below are verbatim substrings of it.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatResponse(content: unknown): Response {
  return jsonResponse({
    model: "test-model-v1",
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } },
    ],
  });
}

const DECISION_JSON = {
  action: "escrow_release",
  reason: "Section 3(b) pays into escrow with scheduled releases.",
  cited_clause: {
    excerpt_id: "03-second-amendment.pdf#§3",
    quote: "shall be released to the consultant",
  },
  confidence: 0.9,
};

const SCHEDULE_JSON = {
  monthly_amount: {
    text: "$6,000",
    excerpt_id: "03-second-amendment.pdf#§3",
    quote: "paid $6,000 per month",
  },
  period: {
    text: "6-month",
    excerpt_id: "03-second-amendment.pdf#§3",
    quote: "for the 6-month period",
  },
  releases: [
    {
      amount_text: "$36,000",
      date_text: "January 2, 2027",
      condition_text: null,
      excerpt_id: "03-second-amendment.pdf#§3",
      quote: "$36,000 shall be released to the consultant on January 2, 2027",
    },
  ],
  confidence: 0.9,
};

// A full $36,000 deposit plus a full $36,000 early release: both move the
// entire escrow value to the funding date and pass all four scenario checks.
const PROPOSAL_JSON = {
  round_note: "the whole escrow arrives too late; move it all to funding",
  done: true,
  candidates: [
    {
      lever: "upfront_deposit",
      amount_cents: 3600000,
      date: "2026-10-01",
      split_count: null,
      net_days: null,
      rationale: "cash at signing beats escrow",
    },
    {
      lever: "earlier_release",
      amount_cents: 3600000,
      date: "2026-10-01",
      split_count: null,
      net_days: null,
      rationale: "release it all immediately",
    },
  ],
};

// A valid retainer review for the canned sections — citations verbatim in the
// file-0 §1.3/§1.4/§1.5 text above.
function writeReviewsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caveat-reviews-"));
  writeFileSync(
    join(dir, "retainer-review.json"),
    JSON.stringify({
      questionId: "retainer_after_second_amendment",
      reviewer: "Test Reviewer",
      reviewedAt: "2026-11-24",
      baseRetainer: {
        answer: "unresolved_compare_both",
        note: "comparing both readings",
        citations: [
          {
            fileName: "01-consulting-agreement.pdf",
            section: "§1.3",
            quote: "a rate of $6,000 per month",
          },
        ],
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
            quote: "payable on the 1st of each month",
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
        citations: [
          {
            fileName: "02-first-amendment.pdf",
            section: "§1",
            quote: "Body text",
          },
        ],
      },
    }),
  );
  return dir;
}

// fetch router: Box REST calls by URL, chat calls by schema name in the body.
function stubFetch(
  opts: {
    versionId?: string;
    chatCounts?: Record<string, number>;
    file2Lines?: string[];
    cashBytes?: Uint8Array | undefined;
    replyKind?: "pass" | "fail" | "unreadable";
    counterJson?: unknown;
    proposalJson?: unknown;
    typesafe?: {
      decisionAnswers?: Record<string, unknown>;
      gateNoul?: number;
      calls?: string[];
    };
  } = {},
): void {
  const impl = (url: unknown, init?: unknown): Promise<Response> => {
    const u = String(url);
    const body = (init as { body?: unknown } | undefined)?.body;
    const schema =
      typeof body === "string"
        ? (JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } })
            .response_format?.json_schema?.name
        : undefined;

    if (u === `${TS}/v1/systemone`) {
      const questions =
        typeof body === "string"
          ? (JSON.parse(body) as { questions?: Record<string, unknown> }).questions
          : undefined;
      const kind =
        questions !== undefined && "release_timing" in questions
          ? "release_timing"
          : questions !== undefined && "release_timing_source" in questions
            ? "release_timing_source"
            : questions !== undefined && "single_payment_change" in questions
              ? "client_letter_gate"
              : "other";
      opts.typesafe?.calls?.push(kind);
      const decisionAnswers =
        opts.typesafe?.decisionAnswers ?? JEV_DECIDED_ANSWERS;
      const answers =
        kind === "client_letter_gate"
          ? {
              single_payment_change: {
                type: "noul",
                noul: opts.typesafe?.gateNoul ?? 0.95,
              },
            }
          : { [kind]: decisionAnswers[kind as keyof typeof decisionAnswers] };
      return Promise.resolve(
        jsonResponse({
          model: "jev-1.14.0",
          answers,
          usage: { input_tokens: 9, output_tokens: 2 },
        }),
      );
    }
    if (u === `${OR}/v1/chat/completions`) {
      if (opts.chatCounts !== undefined && schema !== undefined) {
        opts.chatCounts[schema] = (opts.chatCounts[schema] ?? 0) + 1;
      }
      if (schema === "release_timing_decision") {
        return Promise.resolve(chatResponse(DECISION_JSON));
      }
      if (schema === "counteroffer_proposal") {
        return Promise.resolve(
          chatResponse(opts.proposalJson !== undefined ? opts.proposalJson : PROPOSAL_JSON),
        );
      }
      if (schema === "client_counter") {
        if (opts.counterJson !== undefined) {
          return Promise.resolve(chatResponse(opts.counterJson));
        }
        return Promise.resolve(chatResponse(CLIENT_COUNTER_JSON[opts.replyKind ?? "pass"]));
      }
      return Promise.resolve(chatResponse(SCHEDULE_JSON));
    }
    if (u.startsWith(`${BOX}/2.0/folders/0/items`)) {
      return Promise.resolve(
        jsonResponse({ entries: [{ id: "F1", type: "folder", name: "caveat_TEST" }] }),
      );
    }
    if (u.startsWith(`${BOX}/2.0/folders/F1/items`)) {
      return Promise.resolve(
        jsonResponse({
          entries: [
            ...FILE_NAMES.map((name, i) => ({ id: `file-${i}`, type: "file", name })),
            ...(opts.cashBytes !== undefined
              ? [{ id: "file-cash", type: "file", name: "my-cash.csv" }]
              : []),
            ...(opts.replyKind !== undefined
              ? [{ id: "file-reply", type: "file", name: "04-client-reply.pdf" }]
              : []),
          ],
        }),
      );
    }
    if (opts.cashBytes !== undefined && u.startsWith(`${BOX}/2.0/files/file-cash/content`)) {
      return Promise.resolve(new Response(opts.cashBytes, { status: 200 }));
    }
    if (opts.cashBytes !== undefined && u.startsWith(`${BOX}/2.0/files/file-cash?`)) {
      const bytes = opts.cashBytes;
      return Promise.resolve(
        jsonResponse({
          id: "file-cash",
          name: "my-cash.csv",
          size: bytes.byteLength,
          sha1: createHash("sha1").update(bytes).digest("hex"),
          file_version: { id: opts.versionId ?? "v1" },
          modified_at: "2026-01-01T00:00:00Z",
        }),
      );
    }
    if (opts.replyKind !== undefined && u.startsWith(`${BOX}/2.0/files/file-reply/content`)) {
      return Promise.resolve(
        new Response(replyBytes(opts.replyKind), { status: 200 }),
      );
    }
    if (opts.replyKind !== undefined && u.startsWith(`${BOX}/2.0/files/file-reply?`)) {
      const bytes = replyBytes(opts.replyKind);
      return Promise.resolve(
        jsonResponse({
          id: "file-reply",
          name: "04-client-reply.pdf",
          size: bytes.byteLength,
          sha1: createHash("sha1").update(bytes).digest("hex"),
          file_version: { id: opts.versionId ?? "v1" },
          modified_at: "2026-01-01T00:00:00Z",
        }),
      );
    }
    const content = u.match(/\/2\.0\/files\/(file-\d)\/content/);
    if (content !== null) {
      return Promise.resolve(new Response(fileBytes(content[1]!, opts.file2Lines), { status: 200 }));
    }
    const meta = u.match(/\/2\.0\/files\/(file-\d)\?/);
    if (meta !== null) {
      const bytes = fileBytes(meta[1]!, opts.file2Lines);
      return Promise.resolve(
        jsonResponse({
          id: meta[1],
          name: FILE_NAMES[Number(meta[1]!.slice(5))],
          size: bytes.byteLength,
          sha1: createHash("sha1").update(bytes).digest("hex"),
          file_version: { id: opts.versionId ?? "v1" },
          modified_at: "2026-01-01T00:00:00Z",
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  vi.stubGlobal("fetch", impl);
}

// Marker so a changed file-2 line set is distinguishable in the byte payload.
const FILE2_CHANGED_MARKER = "CHANGED-SECTION-TEXT";

function fileBytes(id: string, file2Lines?: string[]): Uint8Array {
  const marker = id === "file-2" && file2Lines !== undefined ? `-${FILE2_CHANGED_MARKER}` : "";
  return new TextEncoder().encode(`pdf-bytes-${id}${marker}`);
}

const FILE2_LINES = [
  "3. Transaction Compensation",
  "The Consultant shall be paid $6,000 per month",
  "for the 6-month period into escrow.",
  "(i) $36,000 shall be released to the",
  "consultant on January 2, 2027.",
];

// Same operative content but the heading differs — the section text and its
// digest change while every model quote stays verbatim.
const FILE2_LINES_CHANGED = [
  "3. Transaction Compensation and Escrow",
  "The Consultant shall be paid $6,000 per month",
  "for the 6-month period into escrow.",
  "(i) $36,000 shall be released to the",
  "consultant on January 2, 2027.",
];

function replyBytes(kind: "pass" | "fail" | "unreadable"): Uint8Array {
  return new TextEncoder().encode(`pdf-bytes-reply-${kind}`);
}

const REPLY_LINES_PASS = [
  "SYNTHETIC CLIENT REPLY - TEST FIXTURE",
  "1. Response",
  "Thank you for the proposed change to the escrow schedule in the Second Amendment.",
  "2. Counterproposal",
  "We propose that $36,000 of the escrow funding be paid to you as an upfront",
  "deposit on October 1, 2026, with the January 2, 2027 release reduced by the",
  "same amount.",
  "3. Other Terms",
  "All other terms of the Second Amendment remain unchanged.",
];

const REPLY_LINES_FAIL = REPLY_LINES_PASS.map((l) => l.replace("$36,000", "$500"));

const CLIENT_COUNTER_JSON: Record<"pass" | "fail" | "unreadable", unknown> = {
  pass: {
    readable: true,
    lever: "upfront_deposit",
    amount_text: "$36,000",
    date_text: "October 1, 2026",
    split_count_text: null,
    net_days_text: null,
    excerpt_id: "04-client-reply.pdf#§2",
    quote:
      "We propose that $36,000 of the escrow funding be paid to you as an upfront deposit on October 1, 2026, with the January 2, 2027 release reduced by the same amount.",
    unclear_note: null,
    confidence: 0.95,
  },
  fail: {
    readable: true,
    lever: "upfront_deposit",
    amount_text: "$500",
    date_text: "October 1, 2026",
    split_count_text: null,
    net_days_text: null,
    excerpt_id: "04-client-reply.pdf#§2",
    quote:
      "We propose that $500 of the escrow funding be paid to you as an upfront deposit on October 1, 2026, with the January 2, 2027 release reduced by the same amount.",
    unclear_note: null,
    confidence: 0.95,
  },
  unreadable: {
    readable: false,
    lever: null,
    amount_text: null,
    date_text: null,
    split_count_text: null,
    net_days_text: null,
    excerpt_id: null,
    quote: null,
    unclear_note: "the letter proposes two different changes",
    confidence: 0.9,
  },
};

// The pdfText seam: canned page lines per byte payload.
function cannedPdfLines(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const lines = text.includes("reply-pass")
    ? REPLY_LINES_PASS
    : text.includes("reply-fail") || text.includes("reply-unreadable")
      ? REPLY_LINES_FAIL
      : text.includes("file-2")
    ? text.includes(FILE2_CHANGED_MARKER)
      ? FILE2_LINES_CHANGED
      : FILE2_LINES
    : text.includes("file-0")
      ? [
          "1. Retainer",
          "1.3 The Company shall pay the Consultant a rate of $6,000 per month for services.",
          "1.4 The retainer is payable on the 1st of each month.",
          "1.5 This agreement shall expire on December 31, 2026.",
        ]
      : ["1. Scope", "Body text."];
  return Promise.resolve([{ page: 1, lines }]);
}

describe("runPipeline orchestration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs evidence->decision->review end to end with stubbed gateways", async () => {
    stubFetch();
    const result = await runPipeline({
      ...config,
      reviewsDir: "no-such-dir",
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
    });
    const { receipt, sourceTuple, sections, timingsMs } = result;

    expect(sourceTuple).toHaveLength(3);
    for (const [i, entry] of sourceTuple.entries()) {
      expect(entry.fileName).toBe(FILE_NAMES[i]);
      expect(entry.sha256).toBe(
        createHash("sha256").update(fileBytes(`file-${i}`)).digest("hex"),
      );
      expect(entry.versionId).toBe("v1");
    }

    const sectionIds = sections.map((s) => `${s.fileName}#${s.sectionId}`);
    expect(sectionIds).toContain("03-second-amendment.pdf#§3");

    expect(receipt.releaseTiming?.outcome.status).toBe("decided");
    expect(receipt.effectiveAction).toBe("escrow_release");
    expect(receipt.schedule?.outcome.status).toBe("extracted");

    // The review dir is absent, so the run is blocked but the receipt is whole.
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain(
      "review_citation_invalid",
    );
    expect(receipt.readings).toHaveLength(0);

    for (const key of [
      "gateway_list",
      "box_fetch",
      "sections",
      "release_timing",
      "schedule",
      "flags",
      "human_review",
      "runner",
      "total",
    ]) {
      expect(timingsMs).toHaveProperty(key);
    }
  });

  it("runs the counteroffer search on the worker pool after clean readings", async () => {
    stubFetch();
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const result = await runPipeline({
      ...config,
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
    });
    const { receipt } = result;

    // Nothing blocked: the review validates, the search found a passing change.
    expect(receipt.status).toBe("reviewable");
    expect(receipt.blockedReasons).toHaveLength(0);
    expect(receipt.readings).toHaveLength(2);

    const search = receipt.counteroffer;
    expect(search?.status).toBe("found");
    expect(search?.stopReason).toBe("model_done");
    expect(search?.best).toBe("r1c1");
    expect(search?.rounds[0]?.modelNote).toBe(
      "the whole escrow arrives too late; move it all to funding",
    );
    const [first, second] = search?.rounds[0]?.candidates ?? [];
    expect(first?.status).toBe("tested");
    expect(first?.passesAll).toBe(true);
    expect(second?.status).toBe("tested");
    // Both workers were used — one runBatch call per worker, concurrently.
    expect(pool.calls.map((c) => c.worker).sort()).toEqual(["wa-test", "wb-test"]);
    expect(first?.inputDigests?.retainer_superseded).toBeTruthy();
    expect(first?.resultDigests?.retainer_continues).toBeTruthy();
  });

  it("reports workers_unavailable naming the missing connector", async () => {
    stubFetch();
    // No worker connectors in the list and no injected pool: the search must
    // come back needs_review naming the first connector it looked for.
    const result = await runPipeline({
      ...config,
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
    });
    const search = result.receipt.counteroffer;
    expect(search?.status).toBe("needs_review");
    expect(search?.reason).toBe("workers_unavailable");
    expect(search?.detail).toContain("caveat-worker-a");
    expect(result.receipt.status).toBe("needs_review");
  });

  it("fails at box_file when a named file is absent from the folder", async () => {
    vi.stubGlobal("fetch", (url: unknown) => {
      const u = String(url);
      if (u.includes("/folders/0/items")) {
        return Promise.resolve(
          jsonResponse({ entries: [{ id: "F1", type: "folder", name: "caveat_TEST" }] }),
        );
      }
      if (u.includes("/folders/F1/items")) {
        return Promise.resolve(
          jsonResponse({
            entries: [{ id: "file-1", type: "file", name: "02-first-amendment.pdf" }],
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const error = await runPipeline({
      ...config,
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { step?: string }).step).toBe("box_file");
  });
});

describe("incremental reruns", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function firstRun() {
    stubFetch();
    const result = await runPipeline({
      ...config,
      runId: "run-1",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: new InProcessPool(["wa-test", "wb-test"]),
    });
    expect(result.receipt.status).toBe("reviewable");
    expect(result.receipt.counteroffer?.status).toBe("found");
    return result;
  }

  it("carries every typed call when only version ids changed", async () => {
    const first = await firstRun();
    const chatCounts: Record<string, number> = {};
    stubFetch({ versionId: "v2", chatCounts });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      trigger: "watcher",
      previous: {
        runId: "run-1",
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
    });
    const r = second.receipt;

    // Bytes identical, only version ids differed: zero model calls at all.
    expect(Object.values(chatCounts).reduce((a, b) => a + b, 0)).toBe(0);

    expect(r.incremental?.previousRunId).toBe("run-1");
    expect(r.incremental?.mode).toBe("incremental");
    expect(r.incremental?.changedSections).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(r.incremental?.changedFiles).toHaveLength(3);
    for (const f of r.incremental?.changedFiles ?? []) {
      expect(f.contentChanged).toBe(false);
      expect(f.fromVersionTag).not.toBe(f.toVersionTag);
    }
    expect(r.incremental?.reran).toEqual([]);
    expect(r.incremental?.carriedForward).toEqual([
      "release_timing",
      "escrow_schedule",
      "counteroffer_search",
    ]);

    expect(r.releaseTiming?.outcome.status).toBe("decided");
    expect(
      r.releaseTiming?.outcome.status === "decided"
        ? r.releaseTiming.outcome.carriedFrom
        : undefined,
    ).toBe("run-1");
    expect(
      r.schedule?.outcome.status === "extracted"
        ? r.schedule.outcome.carriedFrom
        : undefined,
    ).toBe("run-1");

    // The found search was carried; its best candidate was re-verified once on
    // the first worker (both readings in a single batch).
    const search = r.counteroffer;
    expect(search?.status).toBe("found");
    expect(search?.carriedFrom).toBe("run-1");
    expect(search?.reverifiedOn).toBe("wa-test");
    expect(search?.rounds).toEqual(first.receipt.counteroffer?.rounds);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.worker).toBe("wa-test");
    expect(pool.calls[0]?.jobs).toHaveLength(2);

    expect(r.trigger).toBe("watcher");
    expect(r.status).toBe("reviewable");
    expect(r.sectionDigests).toEqual(first.receipt.sectionDigests);
    expect(r.typedCallDigests).toEqual(first.receipt.typedCallDigests);
  });

  it("carries each call from an older source when the newest reviewable run has a different digest", async () => {
    const first = await firstRun();
    const chatCounts: Record<string, number> = {};
    stubFetch({ versionId: "v2", chatCounts });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const otherDigests = JSON.parse(
      JSON.stringify(first.receipt),
    ) as RunReceipt;
    otherDigests.typedCallDigests = {
      release_timing: "other",
      escrow_schedule: "other",
      counteroffer_search: "other",
    };
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      trigger: "watcher",
      previous: {
        runId: "run-1",
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [
        { runId: "run-other", receipt: otherDigests },
        { runId: "run-1", receipt: first.receipt },
      ],
    });
    const r = second.receipt;

    expect(r.status).toBe("reviewable");
    expect(r.incremental?.carriedForward).toEqual([
      "release_timing",
      "escrow_schedule",
      "counteroffer_search",
    ]);
    // Every call skipped the newest source's non-matching digest and carried
    // from run-1 instead.
    expect(
      r.releaseTiming?.outcome.status === "decided"
        ? r.releaseTiming.outcome.carriedFrom
        : undefined,
    ).toBe("run-1");
    expect(
      r.schedule?.outcome.status === "extracted"
        ? r.schedule.outcome.carriedFrom
        : undefined,
    ).toBe("run-1");
    expect(r.counteroffer?.carriedFrom).toBe("run-1");
    expect(r.counteroffer?.reverifiedOn).toBe("wa-test");
    // Zero model calls: both typed calls carried too.
    expect(Object.values(chatCounts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("never carries from a needs_review source", async () => {
    const first = await firstRun();
    const chatCounts: Record<string, number> = {};
    stubFetch({ versionId: "v2", chatCounts });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const blocked = JSON.parse(JSON.stringify(first.receipt)) as RunReceipt;
    blocked.status = "needs_review";
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      trigger: "watcher",
      previous: {
        runId: "run-1",
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [{ runId: "run-blocked", receipt: blocked }],
    });
    const r = second.receipt;

    expect(r.status).toBe("reviewable");
    expect(r.incremental?.carriedForward).toEqual([]);
    expect(
      r.releaseTiming?.outcome.status === "decided"
        ? r.releaseTiming.outcome.carriedFrom
        : undefined,
    ).toBeUndefined();
    expect(
      r.schedule?.outcome.status === "extracted"
        ? r.schedule.outcome.carriedFrom
        : undefined,
    ).toBeUndefined();
    expect(r.counteroffer?.carriedFrom).toBeUndefined();
    // release_timing + escrow_schedule + the search round all ran fresh.
    expect(chatCounts.release_timing_decision).toBe(1);
    expect(chatCounts.schedule_extraction).toBe(1);
  });

  it("re-asks the model for release_timing and escrow_schedule when §3 changed", async () => {
    const first = await firstRun();
    const chatCounts: Record<string, number> = {};
    stubFetch({ versionId: "v2", chatCounts, file2Lines: FILE2_LINES_CHANGED });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      previous: {
        runId: "run-1",
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
    });
    const r = second.receipt;

    expect(chatCounts.release_timing_decision).toBe(1);
    expect(chatCounts.schedule_extraction).toBe(1);
    // The schedule re-extracted identically, so the search inputs did not
    // change and it was still carried (with re-verification, not a new search).
    expect(chatCounts.counteroffer_proposal).toBeUndefined();

    expect(r.incremental?.changedSections.changed).toContain(
      "03-second-amendment.pdf#§3",
    );
    expect(r.incremental?.reran).toEqual(["release_timing", "escrow_schedule"]);
    expect(r.incremental?.carriedForward).toEqual(["counteroffer_search"]);
    expect(
      r.releaseTiming?.outcome.status === "decided"
        ? r.releaseTiming.outcome.carriedFrom
        : undefined,
    ).toBeUndefined();
    expect(r.counteroffer?.carriedFrom).toBe("run-1");
    expect(r.status).toBe("reviewable");
  });

  it("blocks on carried_search_mismatch when a previous resultDigest was tampered", async () => {
    const first = await firstRun();
    const tampered = structuredClone(first.receipt);
    const search = tampered.counteroffer;
    const best = search?.rounds
      .flatMap((r) => r.candidates)
      .find((c) => c.id === search.best);
    expect(best?.resultDigests).toBeDefined();
    for (const key of Object.keys(best?.resultDigests ?? {})) {
      best!.resultDigests![key] = "tampered";
    }
    stubFetch({ versionId: "v2" });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      previous: {
        runId: "run-1",
        receipt: tampered,
        sourceTuple: first.sourceTuple,
      },
    });

    expect(second.receipt.counteroffer?.status).toBe("needs_review");
    expect(second.receipt.counteroffer?.reason).toBe("carried_search_mismatch");
    expect(second.receipt.status).toBe("needs_review");
    expect(
      second.receipt.blockedReasons.map((r) => r.reason),
    ).toContain("carried_search_mismatch");
    // The re-verification batch did run — the mismatch is in its output.
    expect(pool.calls).toHaveLength(1);
  });

  it("runs full_no_baseline when the previous receipt lacks digests", async () => {
    const first = await firstRun();
    const bare = structuredClone(first.receipt);
    delete bare.typedCallDigests;
    const chatCounts: Record<string, number> = {};
    stubFetch({ versionId: "v2", chatCounts });
    const pool = new InProcessPool(["wa-test", "wb-test"]);
    const second = await runPipeline({
      ...config,
      runId: "run-2",
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      assertExpected: false,
      workerPool: pool,
      previous: {
        runId: "run-1",
        receipt: bare,
        sourceTuple: first.sourceTuple,
      },
    });

    expect(second.receipt.incremental?.mode).toBe("full_no_baseline");
    expect(second.receipt.incremental?.changedSections).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(second.receipt.incremental?.reran).toEqual([
      "release_timing",
      "escrow_schedule",
      "counteroffer_search",
    ]);
    expect(second.receipt.incremental?.carriedForward).toEqual([]);
    expect(chatCounts.release_timing_decision).toBe(1);
    expect(chatCounts.schedule_extraction).toBe(1);
    expect(chatCounts.counteroffer_proposal).toBe(1);
    expect(second.receipt.status).toBe("reviewable");
  });
});

describe("owner cash file", () => {
  const CSV_V1 = readFileSync(
    fileURLToPath(new URL("../../fixtures/box/my-cash.csv", import.meta.url)),
  );
  const CSV_V2 = readFileSync(
    fileURLToPath(new URL("../../fixtures/box/my-cash-v2.csv", import.meta.url)),
  );

  async function run(cashBytes?: Uint8Array) {
    stubFetch({ cashBytes });
    return runPipeline({
      ...config,
      reviewsDir: writeReviewsDir(),
      connections: CONNECTIONS,
      pdfText: cannedPdfLines,
      workerPool: new InProcessPool(["wa-test", "wb-test"]),
    });
  }

  it("uses the demo assumptions when no cash file is present", async () => {
    const { receipt } = await run();
    expect(receipt.cashSource).toEqual({ kind: "demo_assumptions" });
    // The canned extraction is a mock that does not equal the committed
    // expected fixtures; the point is the check ran on the demo numbers.
    expect(receipt.expectedCheck).toBe("mismatch");
    expect(receipt.sources.map((s) => s.fileName)).not.toContain("my-cash.csv");
  });

  it("uses a valid cash file and still matches expected when numbers are identical", async () => {
    const demo = await run();
    const { receipt } = await run(CSV_V1);
    expect(receipt.cashSource?.kind).toBe("owner_file");
    if (receipt.cashSource?.kind !== "owner_file") throw new Error("unreachable");
    expect(receipt.cashSource.fileName).toBe("my-cash.csv");
    expect(receipt.cashSource.versionTag).toMatch(/^[0-9a-f]{12}$/);
    expect(receipt.cashSource.sha12).toMatch(/^[0-9a-f]{12}$/);
    expect(receipt.expectedCheck).toBe("mismatch");
    expect(receipt.sources.map((s) => s.fileName)).toContain("my-cash.csv");
    expect(receipt.sources.find((s) => s.fileName === "my-cash.csv")?.edgarUrl).toBeNull();
    // Same numbers -> the same runner results as the demo run.
    expect(receipt.readings.map((r) => r.resultDigest)).toEqual(
      demo.receipt.readings.map((r) => r.resultDigest),
    );
    // The csv is in the source tuple, so approvals bind to its version.
    expect((await run(CSV_V1)).sourceTuple.map((f) => f.fileName)).toContain("my-cash.csv");
  });

  it("skips the expected check and reruns the numbers on different cash figures", async () => {
    const { receipt } = await run(CSV_V2);
    expect(receipt.cashSource?.kind).toBe("owner_file");
    expect(receipt.expectedCheck).toBe("skipped_custom_cash");
    // 23000 opening - 3 x 6000 costs by Dec 15 = 5000, under the 10000 floor.
    expect(
      receipt.readings.find((r) => r.id === "retainer_superseded")?.results.as_signed
        ?.all_extensions?.lowest,
    ).toEqual({
      date: "2026-12-15",
      balanceCents: 500000,
    });
  });

  it("blocks an invalid cash file instead of falling back", async () => {
    const bad = new TextEncoder().encode(
      "kind,date,amount_usd\nopening,2026-10-01,nope\nfloor,,10000.00\ncost,2026-10-15,6000.00\n",
    );
    const { receipt } = await run(bad);
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons).toContainEqual(
      expect.objectContaining({ reason: "cash_file_invalid" }),
    );
    const detail = receipt.blockedReasons.find(
      (r) => r.reason === "cash_file_invalid",
    )?.detail;
    expect(detail).toMatch(/^line 2: bad_amount: /);
    // An invalid file is labelled, not silently replaced: no demo results.
    expect(receipt.cashSource?.kind).toBe("owner_file_invalid");
    if (receipt.cashSource?.kind !== "owner_file_invalid") throw new Error("unreachable");
    expect(receipt.cashSource.fileName).toBe("my-cash.csv");
    expect(receipt.cashSource.versionTag).toMatch(/^[0-9a-f]{12}$/);
    expect(receipt.cashSource.sha12).toMatch(/^[0-9a-f]{12}$/);
    expect(receipt.cashSource.detail).toBe(detail);
    expect(receipt.readings).toEqual([]);
    expect(receipt.expectedCheck).toBeUndefined();
    expect(receipt.counteroffer).toBeUndefined();
  });
});

describe("client reply", () => {
  afterEach(() => vi.unstubAllGlobals());

  const runOpts = (extra: Record<string, unknown> = {}) => ({
    ...config,
    reviewsDir: writeReviewsDir(),
    connections: CONNECTIONS,
    pdfText: cannedPdfLines,
    assertExpected: false,
    ...extra,
  });
  const POOL = () => new InProcessPool(["wa-test", "wb-test"]);

  it("safe: a passing counter is tested on every worker", async () => {
    stubFetch({ replyKind: "pass" });
    const pool = POOL();
    const result = await runPipeline(runOpts({ workerPool: pool }));
    const r = result.receipt;
    expect(r.status).toBe("reviewable");

    const reply = r.clientReply;
    expect(reply?.status).toBe("safe");
    expect(reply?.fileName).toBe("04-client-reply.pdf");
    expect(reply?.citation?.quote).toContain("$36,000");
    expect(reply?.counter?.id).toBe("client");
    expect(reply?.counter?.lever).toBe("upfront_deposit");
    expect(reply?.counter?.passesAll).toBe(true);
    expect([...(reply?.workers ?? [])].sort()).toEqual(["wa-test", "wb-test"]);
    expect(reply?.counter?.workers?.sort()).toEqual(["wa-test", "wb-test"]);
    expect(reply?.response).toBeUndefined();

    // The reply is a source and its sections are digested, but its sections
    // stay out of the contract's section list.
    expect(r.sources.map((s) => s.fileName)).toContain("04-client-reply.pdf");
    expect(r.sources.find((s) => s.fileName === "04-client-reply.pdf")?.edgarUrl).toBeNull();
    expect(r.typedCallDigests?.client_counter).toBeTruthy();
    expect(r.sectionDigests?.["04-client-reply.pdf#§2"]).toBeTruthy();
    expect(result.sections.every((s) => s.fileName !== "04-client-reply.pdf")).toBe(true);
    expect(result.sourceTuple).toHaveLength(4);
  });

  it("countered: a failing counter seeds a follow-up search it can bound but never win", async () => {
    stubFetch({ replyKind: "fail" });
    const pool = POOL();
    const r = (await runPipeline(runOpts({ workerPool: pool }))).receipt;
    expect(r.status).toBe("reviewable");

    const reply = r.clientReply;
    expect(reply?.status).toBe("countered");
    expect(reply?.counter?.passesAll).toBe(false);
    const response = reply?.response;
    expect(response?.status).toBe("found");
    expect(response?.best).toBe("reply-r1c1");
    // The seed joined the brackets and can bound the best — it is never a
    // round candidate and so can never be chosen as best.
    expect(response?.bound?.candidate).toBe("client");
    for (const round of response?.rounds ?? []) {
      for (const c of round.candidates) {
        expect(c.id).toMatch(/^reply-/);
      }
    }
    expect(r.typedCallDigests?.client_reply_search).toBeTruthy();
  });

  it("no_fix: no passing follow-up adds the client_counter_no_fix block", async () => {
    stubFetch({
      replyKind: "fail",
      proposalJson: { round_note: "nothing helps", done: true, candidates: [] },
    });
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;
    const reply = r.clientReply;
    expect(reply?.status).toBe("no_fix");
    expect(reply?.response?.status).toBe("not_found");
    expect(r.status).toBe("needs_review");
    expect(r.blockedReasons.map((b) => b.reason)).toContain("client_counter_no_fix");
  });

  it("needs_review: an unreadable letter routes to human review", async () => {
    stubFetch({ replyKind: "unreadable" });
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;
    const reply = r.clientReply;
    expect(reply?.status).toBe("needs_review");
    expect(reply?.reason).toBe("counter_unreadable");
    expect(reply?.detail).toContain("two different changes");
    expect(reply?.counter).toBeUndefined();
    expect(r.status).toBe("needs_review");
    expect(r.blockedReasons.map((b) => b.reason)).toContain("counter_unreadable");
  });

  it("needs_review on a single-worker pool", async () => {
    stubFetch({ replyKind: "pass" });
    const r = (
      await runPipeline(runOpts({ workerPool: new InProcessPool(["wa-test"]) }))
    ).receipt;
    const reply = r.clientReply;
    expect(reply?.status).toBe("needs_review");
    expect(reply?.reason).toBe("workers_unavailable");
    expect(r.status).toBe("needs_review");
  });

  it("needs_review on worker disagreement", async () => {
    stubFetch({ replyKind: "pass" });
    class DisagreeingPool extends InProcessPool {
      async runBatch(
        worker: string,
        jobs: WorkerJob[],
      ): Promise<WorkerJobResult[]> {
        const results = await super.runBatch(worker, jobs);
        if (worker === "wb-test") {
          for (const r of results) {
            if (r.jobId.startsWith("client@") && r.ok) {
              (r.output as { resultDigest: string }).resultDigest = "tampered";
            }
          }
        }
        return results;
      }
    }
    const r = (
      await runPipeline(runOpts({ workerPool: new DisagreeingPool(["wa-test", "wb-test"]) }))
    ).receipt;
    const reply = r.clientReply;
    expect(reply?.status).toBe("needs_review");
    expect(reply?.reason).toBe("worker_disagreement");
    expect(r.status).toBe("needs_review");
  });

  it("carries the reply read by call digest when nothing relevant changed", async () => {
    const chatCounts: Record<string, number> = {};
    stubFetch({ replyKind: "pass", chatCounts });
    const first = await runPipeline(
      runOpts({ runId: "run-1", workerPool: POOL() }),
    );
    expect(first.receipt.clientReply?.status).toBe("safe");
    expect(chatCounts["client_counter"]).toBe(1);

    stubFetch({ replyKind: "pass", versionId: "v2", chatCounts });
    const second = await runPipeline(
      runOpts({
        runId: "run-2",
        trigger: "watcher",
        workerPool: POOL(),
        previous: {
          runId: "run-1",
          receipt: first.receipt,
          sourceTuple: first.sourceTuple,
        },
      }),
    );
    const r = second.receipt;
    // Same letter bytes: the read was carried, no second model call.
    expect(chatCounts["client_counter"]).toBe(1);
    expect(r.incremental?.carriedForward).toContain("client_counter");
    expect(r.clientReply?.status).toBe("safe");
    expect(r.clientReply?.counter?.passesAll).toBe(true);
  });

  it("a run without a reply stays byte-identical", async () => {
    stubFetch();
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;
    expect(r.clientReply).toBeUndefined();
    expect(Object.keys(r.typedCallDigests ?? {})).toEqual([
      "release_timing",
      "escrow_schedule",
      "counteroffer_search",
    ]);
  });
});

describe("Jev provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  const runOpts = (extra: Record<string, unknown> = {}) => ({
    ...config,
    reviewsDir: writeReviewsDir(),
    connections: TYPESAFE_CONNECTIONS,
    pdfText: cannedPdfLines,
    assertExpected: false,
    ...extra,
  });
  const POOL = () => new InProcessPool(["wa-test", "wb-test"]);

  it("decides release_timing via Jev, gates the letter, then extracts with OpenRouter", async () => {
    const calls: string[] = [];
    const chatCounts: Record<string, number> = {};
    stubFetch({ replyKind: "pass", chatCounts, typesafe: { calls } });
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;

    expect(r.status).toBe("reviewable");
    // The decision came from Jev with both questions' probabilities stored.
    const outcome = r.releaseTiming?.outcome;
    expect(outcome?.provider).toBe("typesafe");
    expect(outcome?.model).toBe("jev-1.14.0");
    expect(outcome?.jev?.questions.release_timing?.choice).toBe("escrow_release");
    expect(outcome?.jev?.questions.release_timing_source?.choice).toBe("e1");
    expect(outcome?.jev?.questions.release_timing?.usage?.input_tokens).toBe(9);
    expect(outcome?.jev?.questions.release_timing_source?.model).toBe("jev-1.14.0");
    if (outcome?.status === "decided") {
      expect(outcome.decision.action).toBe("escrow_release");
      expect(outcome.decision.cited_clause.excerpt_id).toBe(
        "03-second-amendment.pdf#§3",
      );
    } else {
      throw new Error("expected a decided outcome");
    }
    // No OpenRouter release_timing call was made at all.
    expect(chatCounts.release_timing_decision).toBeUndefined();
    expect(calls).toEqual([
      "release_timing",
      "release_timing_source",
      "client_letter_gate",
    ]);
    // The gate passed and was recorded; extraction stayed on OpenRouter.
    expect(r.clientReply?.status).toBe("safe");
    expect(r.clientReply?.gate?.noul).toBe(0.95);
    expect(r.clientReply?.gate?.model).toBe("jev-1.14.0");
    expect(chatCounts.client_counter).toBe(1);
    expect(r.typedCallDigests?.client_letter_gate).toBeTruthy();
  });

  it("a failing gate routes to needs_review with no extraction call", async () => {
    const calls: string[] = [];
    const chatCounts: Record<string, number> = {};
    stubFetch({
      replyKind: "pass",
      chatCounts,
      typesafe: { calls, gateNoul: 0.1 },
    });
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;

    expect(r.status).toBe("needs_review");
    const reply = r.clientReply;
    expect(reply?.status).toBe("needs_review");
    expect(reply?.reason).toBe("counter_not_single_change");
    expect(reply?.gate?.noul).toBe(0.1);
    expect(r.blockedReasons.map((b) => b.reason)).toContain(
      "counter_not_single_change",
    );
    // The gate ran; the OpenRouter extraction never did.
    expect(calls).toEqual([
      "release_timing",
      "release_timing_source",
      "client_letter_gate",
    ]);
    expect(chatCounts.client_counter).toBeUndefined();
    expect(reply?.counter).toBeUndefined();
  });

  it("an uncertain gate is low_confidence, also with no extraction", async () => {
    const chatCounts: Record<string, number> = {};
    stubFetch({ replyKind: "pass", chatCounts, typesafe: { gateNoul: 0.5 } });
    const r = (await runPipeline(runOpts({ workerPool: POOL() }))).receipt;
    expect(r.clientReply?.reason).toBe("low_confidence");
    expect(r.clientReply?.gate?.noul).toBe(0.5);
    expect(chatCounts.client_counter).toBeUndefined();
  });

  it("the gate carries forward by digest like the other typed calls", async () => {
    const firstCalls: string[] = [];
    stubFetch({ replyKind: "pass", typesafe: { calls: firstCalls } });
    const first = await runPipeline(
      runOpts({ runId: "run-j1", workerPool: POOL(), trigger: "watcher" }),
    );
    expect(first.receipt.status).toBe("reviewable");

    // Second run, identical content under new version ids: everything carries.
    const calls: string[] = [];
    const chatCounts: Record<string, number> = {};
    stubFetch({ chatCounts, versionId: "v2", replyKind: "pass", typesafe: { calls } });
    const second = await runPipeline(
      runOpts({
        runId: "run-j2",
        workerPool: POOL(),
        trigger: "watcher",
        previous: {
          runId: "run-j1",
          receipt: first.receipt,
          sourceTuple: first.sourceTuple,
        },
        carrySources: [{ runId: "run-j1", receipt: first.receipt }],
      }),
    );
    const r = second.receipt;
    expect(r.status).toBe("reviewable");
    expect(r.incremental?.carriedForward).toEqual([
      "release_timing",
      "escrow_schedule",
      "counteroffer_search",
      "client_letter_gate",
      "client_counter",
    ]);
    // Not a single Jev call — the gate carried too.
    expect(calls).toEqual([]);
    expect(r.clientReply?.gate?.noul).toBe(0.95);
  });

  it("never carries a Jev decision as an OpenRouter one", async () => {
    stubFetch({ typesafe: { calls: [] } });
    const first = await runPipeline(
      runOpts({ runId: "run-j1", workerPool: POOL() }),
    );
    expect(first.receipt.releaseTiming?.outcome.provider).toBe("typesafe");

    // Without a TypeSafe connection the release_timing digest differs (the
    // provider is inside it), so the previous decision cannot be carried.
    const chatCounts: Record<string, number> = {};
    stubFetch({ chatCounts });
    const second = await runPipeline(
      runOpts({
        runId: "run-j2",
        connections: CONNECTIONS,
        workerPool: POOL(),
        trigger: "watcher",
        previous: {
          runId: "run-j1",
          receipt: first.receipt,
          sourceTuple: first.sourceTuple,
        },
        carrySources: [{ runId: "run-j1", receipt: first.receipt }],
      }),
    );
    const r = second.receipt;
    expect(r.status).toBe("reviewable");
    const outcome = r.releaseTiming?.outcome;
    expect(outcome?.provider).toBe("openrouter");
    expect(
      outcome?.status === "decided" ? outcome.carriedFrom : undefined,
    ).toBeUndefined();
    expect(chatCounts.release_timing_decision).toBe(1);
    expect(r.incremental?.reran).toContain("release_timing");
  });
});
