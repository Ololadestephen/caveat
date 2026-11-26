import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InProcessPool } from "../worker/pool.ts";
import { runGenericPipeline } from "./generic-pipeline.ts";
import type { PipelineConfig } from "./run-pipeline.ts";

const BOX = "http://box.test";
const OR = "http://or.test";
const TS = "http://ts.test";
const CONNECTIONS = [
  { provider: "box", gatewayBaseUrl: BOX },
  { provider: "openrouter", gatewayBaseUrl: OR },
];
const TYPESAFE = [...CONNECTIONS, { provider: "typesafe", gatewayBaseUrl: TS }];

const FILE_NAMES = ["01-agreement.pdf", "02-exhibit-a.pdf"];

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

const TERMS_JSON = {
  terms: [
    {
      kind: "payment_terms",
      amount_text: null,
      date_text: null,
      recurrence_text: null,
      net_days_text: "net thirty (30) calendar days",
      excerpt_id: "01-agreement.pdf#§2",
      quote: "net thirty (30) calendar days after receipt",
      date_excerpt_id: null,
      date_quote: null,
    },
    {
      // The fee's amount and invoice-day rule sit in different excerpts: the
      // term cites §3.1 for the amount and §3.2 for the date.
      kind: "fixed_date_payment",
      amount_text: "$5,000.00",
      date_text: "the last day of the invoiced month",
      recurrence_text: "per month",
      net_days_text: null,
      excerpt_id: "02-exhibit-a.pdf#§3.1",
      quote: "pay Consultant $5,000.00 per month",
      date_excerpt_id: "02-exhibit-a.pdf#§3.2",
      date_quote: "the Fees on the last day of the invoiced month",
    },
    {
      kind: "payment_terms",
      amount_text: null,
      date_text: null,
      recurrence_text: null,
      net_days_text: "net 30 days",
      excerpt_id: "02-exhibit-a.pdf#§3.3",
      quote: "net 30 days after",
      date_excerpt_id: null,
      date_quote: null,
    },
  ],
  term_start: {
    text: "May 29, 2024",
    excerpt_id: "01-agreement.pdf#§3",
    quote: "commence on May 29, 2024",
  },
  term_end: {
    text: "September 29, 2024",
    excerpt_id: "01-agreement.pdf#§3",
    quote: "September 29, 2024",
  },
  confidence: 0.9,
};

const REVIEW_JSON = {
  terms: TERMS_JSON.terms.map((t) => ({
    kind: t.kind,
    excerptId: t.excerpt_id,
    quote: t.quote,
    ...(t.date_excerpt_id !== null ? { dateExcerptId: t.date_excerpt_id } : {}),
    ...(t.date_quote !== null ? { dateQuote: t.date_quote } : {}),
    decision: "confirm",
    reviewer: "owner",
  })),
};

function fileBytes(i: number): Uint8Array {
  return new TextEncoder().encode(`pdf-bytes-${i}`);
}

function cannedPdfLines(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const lines = text.includes("pdf-bytes-0")
    ? [
        "1. Scope",
        "Body text.",
        "2. Fees and Expenses",
        "Terms of payment are net thirty (30) calendar days after receipt of a complete invoice.",
        "3. Term",
        "The term of this Agreement will commence on May 29, 2024 and terminate four months later on September 29, 2024.",
      ]
    : [
        "1. SERVICES",
        "Body text.",
        "2. COMPENSATION",
        "Body text.",
        "3. PRICE AND PAYMENT TERMS",
        "3.1 In consideration for the Services, Company shall pay Consultant $5,000.00 per month.",
        "3.2 Consultant shall invoice Company for the Fees on the last day of the invoiced month.",
        "3.3 Payments shall be paid net 30 days after the date of receipt of Consultant's invoice.",
      ];
  return Promise.resolve([{ page: 1, lines }]);
}

function stubFetch(opts: { noul?: number } = {}) {
  const impl = async (input: URL | string, init?: RequestInit) => {
    const u = String(input);
    if (u === `${TS}/v1/systemone`) {
      const body = JSON.parse((init as { body: string }).body) as {
        questions: Record<string, unknown>;
      };
      const noul = opts.noul ?? 0.95;
      return jsonResponse({
        model: "jev-1.14.0",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((q) => [q, { type: "noul", noul }]),
        ),
        usage: { input_tokens: 9, output_tokens: 2 },
      });
    }
    if (u === `${OR}/v1/chat/completions`) {
      return chatResponse(TERMS_JSON);
    }
    if (u.startsWith(`${BOX}/2.0/folders/0/items`)) {
      return jsonResponse({ entries: [{ id: "F1", type: "folder", name: "caveat_AVIAT" }] });
    }
    if (u.startsWith(`${BOX}/2.0/folders/F1/items`)) {
      return jsonResponse({
        entries: FILE_NAMES.map((name, i) => ({ id: `file-${i}`, type: "file", name })),
      });
    }
    const content = u.match(/\/2\.0\/files\/(file-\d)\/content/);
    if (content !== null) {
      const i = Number(content[1]!.slice(5));
      return Promise.resolve(new Response(fileBytes(i), { status: 200 }));
    }
    const meta = u.match(/\/2\.0\/files\/(file-\d)\?/);
    if (meta !== null) {
      const i = Number(meta[1]!.slice(5));
      const bytes = fileBytes(i);
      return jsonResponse({
        id: meta[1],
        name: FILE_NAMES[i],
        size: bytes.byteLength,
        sha1: createHash("sha1").update(bytes).digest("hex"),
        file_version: { id: "v1" },
        modified_at: "2026-01-01T00:00:00Z",
      });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  vi.stubGlobal("fetch", impl);
}

function config(reviewsDir: string): PipelineConfig {
  return {
    runId: "run-test-1",
    reviewsDir,
    fixturesDir: "fixtures",
    boxFolder: "caveat_AVIAT",
    contract: "aviat",
    connections: TYPESAFE,
    pdfText: cannedPdfLines,
    workerPool: new InProcessPool(["wa-test", "wb-test"]),
  };
}

function reviewsDirWith(file: object | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "caveat-reviews-"));
  if (file !== undefined) {
    writeFileSync(join(dir, "aviat-terms-review.json"), JSON.stringify(file));
  }
  return dir;
}

describe("runGenericPipeline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts, cross-checks, confirms and runs both readings on both workers", async () => {
    stubFetch();
    const result = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    const { receipt } = result;

    expect(receipt.status).toBe("reviewable");
    expect(receipt.blockedReasons).toEqual([]);
    expect(receipt.questionIds).toEqual(["payment_terms"]);
    expect(receipt.paymentTerms?.outcome.status).toBe("extracted");
    expect(receipt.paymentTerms?.crosscheck?.map((c) => c.noul)).toEqual([
      0.95, 0.95, 0.95,
    ]);
    expect(receipt.paymentTerms?.confirmation?.status).toBe("confirmed");
    expect(receipt.typedCallDigests?.payment_terms).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.typedCallDigests?.terms_crosscheck).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.releaseTiming).toBeNull();
    expect(receipt.humanReview.status).toBe("not_applicable");
    expect(receipt.cashSource?.kind).toBe("demo_assumptions");

    // Both readings ran and agreed with the coordinator's digests.
    expect(receipt.readings.map((r) => r.id)).toEqual([
      "partial_months_billed",
      "partial_months_not_billed",
    ]);
    expect(receipt.readings[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.readings[0]?.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.assumptions.floorCents).toBe(200000);
  });

  it("ends needs_review terms_unconfirmed without a review file, before readings", async () => {
    stubFetch();
    const dir = reviewsDirWith(undefined);
    const { receipt } = await runGenericPipeline(config(dir));
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain("terms_unconfirmed");
    expect(receipt.readings).toEqual([]);
    // Extraction and cross-check still ran and are recorded.
    expect(receipt.paymentTerms?.outcome.status).toBe("extracted");
    expect(receipt.paymentTerms?.crosscheck).toHaveLength(3);
  });

  it("blocks with jev_crosscheck_mismatch when Jev rejects a term", async () => {
    stubFetch({ noul: 0.05 });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain("jev_crosscheck_mismatch");
    expect(receipt.readings).toEqual([]);
  });

  it("blocks with low_confidence in the middle band", async () => {
    stubFetch({ noul: 0.5 });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain("low_confidence");
  });

  it("runs no cross-check and no terms_crosscheck digest without a TypeSafe connection", async () => {
    stubFetch();
    const { receipt } = await runGenericPipeline({
      ...config(reviewsDirWith(REVIEW_JSON)),
      connections: CONNECTIONS,
    });
    expect(receipt.paymentTerms?.crosscheck).toBeUndefined();
    expect(receipt.typedCallDigests?.terms_crosscheck).toBeUndefined();
    expect(receipt.status).toBe("reviewable");
  });

  it("carries the extraction and cross-check from a reviewable source", async () => {
    stubFetch();
    const first = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    const chat = vi.fn();
    void chat;
    const second = await runGenericPipeline({
      ...config(reviewsDirWith(REVIEW_JSON)),
      runId: "run-test-2",
      previous: {
        runId: first.receipt.runId,
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [{ runId: first.receipt.runId, receipt: first.receipt }],
    });
    const inc = second.receipt.incremental;
    expect(inc?.previousRunId).toBe(first.receipt.runId);
    expect(inc?.carriedForward).toContain("payment_terms");
    expect(inc?.carriedForward).toContain("terms_crosscheck");
    expect(second.receipt.paymentTerms?.outcome.status).toBe("extracted");
    if (second.receipt.paymentTerms?.outcome.status === "extracted") {
      expect(second.receipt.paymentTerms.outcome.carriedFrom).toBe(first.receipt.runId);
    }
  });

  it("an invalid cash file blocks the run before readings", async () => {
    const impl = async (input: URL | string, init?: RequestInit) => {
      const u = String(input);
      if (u.startsWith(`${BOX}/2.0/folders/F1/items`)) {
        return jsonResponse({
          entries: [
            ...FILE_NAMES.map((name, i) => ({ id: `file-${i}`, type: "file", name })),
            { id: "file-cash", type: "file", name: "my-cash.csv" },
          ],
        });
      }
      const cashBytes = new TextEncoder().encode("bad csv");
      if (u.startsWith(`${BOX}/2.0/files/file-cash/content`)) {
        return Promise.resolve(new Response(cashBytes, { status: 200 }));
      }
      if (u.startsWith(`${BOX}/2.0/files/file-cash?`)) {
        return jsonResponse({
          id: "file-cash",
          name: "my-cash.csv",
          size: cashBytes.byteLength,
          sha1: createHash("sha1").update(cashBytes).digest("hex"),
          file_version: { id: "v1" },
          modified_at: "2026-01-01T00:00:00Z",
        });
      }
      return stubbedInner(input, init);
    };
    const stubbedInner = stubFetchImpl();
    vi.stubGlobal("fetch", impl);
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain("cash_file_invalid");
    expect(receipt.readings).toEqual([]);
  });
});

// Same fake as stubFetch but returned for composition.
function stubFetchImpl(): typeof fetch {
  stubFetch();
  return globalThis.fetch;
}
