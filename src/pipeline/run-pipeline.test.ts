import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runPipeline } from "./run-pipeline.ts";
import { InProcessPool } from "../worker/pool.ts";

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
const CONNECTIONS = [
  { provider: "box", gatewayBaseUrl: BOX },
  { provider: "openrouter", gatewayBaseUrl: OR },
];

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

    if (u === `${OR}/v1/chat/completions`) {
      if (opts.chatCounts !== undefined && schema !== undefined) {
        opts.chatCounts[schema] = (opts.chatCounts[schema] ?? 0) + 1;
      }
      if (schema === "release_timing_decision") {
        return Promise.resolve(chatResponse(DECISION_JSON));
      }
      if (schema === "counteroffer_proposal") {
        return Promise.resolve(chatResponse(PROPOSAL_JSON));
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

// The pdfText seam: canned page lines per byte payload.
function cannedPdfLines(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const lines = text.includes("file-2")
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
    delete bare.sectionDigests;
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
    expect(
      receipt.blockedReasons.find((r) => r.reason === "cash_file_invalid")?.detail,
    ).toMatch(/^line 2: bad_amount: /);
  });
});
