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

const BOUNDS_JSON = {
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

const MISSING_BOUNDS_TERMS_JSON = { ...TERMS_JSON, term_start: null, term_end: null };

function stubFetch(
  opts: {
    noul?: number;
    termsJson?: unknown;
    boundsJson?: unknown;
    clausePick?: string;
    clauseConfidence?: number;
    orCalls?: { schemaName: string; userPrompt: string }[];
  } = {},
) {
  const impl = async (input: URL | string, init?: RequestInit) => {
    const u = String(input);
    if (u === `${TS}/v1/systemone`) {
      const body = JSON.parse((init as { body: string }).body) as {
        questions: Record<string, { type?: string; criteria?: Record<string, string> }>;
      };
      const noul = opts.noul ?? 0.95;
      return jsonResponse({
        model: "jev-1.14.0",
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([q, spec]): [string, unknown] => {
            if (spec.type === "choice") {
              const keys = Object.keys(spec.criteria ?? {});
              const pick = opts.clausePick ?? keys[0]!;
              const confidence = opts.clauseConfidence ?? 0.9;
              return [
                q,
                {
                  type: "choice",
                  choice: pick,
                  confidence,
                  probabilities: Object.fromEntries(
                    keys.map((k) => [k, k === pick ? confidence : 0.05]),
                  ),
                },
              ];
            }
            return [q, { type: "noul", noul }];
          }),
        ),
        usage: { input_tokens: 9, output_tokens: 2 },
      });
    }
    if (u === `${OR}/v1/chat/completions`) {
      const body = JSON.parse((init as { body: string }).body) as {
        response_format?: { json_schema?: { name?: string } };
        messages?: { role: string; content: string }[];
      };
      const schemaName = body.response_format?.json_schema?.name ?? "";
      const userPrompt =
        body.messages?.find((m) => m.role === "user")?.content ?? "";
      opts.orCalls?.push({ schemaName, userPrompt });
      if (schemaName === "term_bounds") {
        return chatResponse(opts.boundsJson ?? BOUNDS_JSON);
      }
      return chatResponse(opts.termsJson ?? TERMS_JSON);
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
      "partial_months_prorated",
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

  it("makes no staged calls when the main extraction states the bounds", async () => {
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ orCalls });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    expect(receipt.status).toBe("reviewable");
    expect(orCalls.map((c) => c.schemaName)).toEqual(["payment_terms"]);
    expect(receipt.paymentTerms?.termClause).toBeUndefined();
    expect(receipt.paymentTerms?.termBounds).toBeUndefined();
    expect(receipt.typedCallDigests?.term_clause).toBeUndefined();
    expect(receipt.typedCallDigests?.term_bounds).toBeUndefined();
  });

  it("narrows the bounds extraction to the Jev-picked clause and merges", async () => {
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3", orCalls });
    const dir = reviewsDirWith(undefined);
    const { receipt } = await runGenericPipeline(config(dir));

    // The merged extraction is validated, then stops for confirmation.
    expect(receipt.status).toBe("needs_review");
    expect(receipt.blockedReasons.map((r) => r.reason)).toEqual(["terms_unconfirmed"]);
    expect(receipt.readings).toEqual([]);
    const outcome = receipt.paymentTerms?.outcome;
    expect(outcome?.status).toBe("extracted");
    if (outcome?.status === "extracted") {
      expect(outcome.terms.boundsFrom).toBe("term_bounds");
      expect(outcome.terms.boundsPick?.choice).toBe("e3");
      expect(outcome.terms.boundsPick?.probabilities.e3).toBe(0.9);
      expect(outcome.terms.termStart?.iso).toBe("2024-05-29");
      expect(outcome.terms.termEnd?.iso).toBe("2024-09-29");
    }
    expect(receipt.paymentTerms?.termClause).toMatchObject({
      question: "term_clause",
      choice: "e3",
      confidence: 0.9,
      model: "jev-1.14.0",
      narrowed: true,
    });
    expect(receipt.paymentTerms?.termBounds?.termStart?.iso).toBe("2024-05-29");
    expect(receipt.typedCallDigests?.term_clause).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.typedCallDigests?.term_bounds).toMatch(/^[0-9a-f]{64}$/);

    // Only the picked excerpt was sent to the bounds call.
    const boundsCall = orCalls.find((c) => c.schemaName === "term_bounds");
    expect(boundsCall).toBeDefined();
    expect(boundsCall?.userPrompt).toContain("commence on May 29, 2024");
    expect(boundsCall?.userPrompt).not.toContain("net 30 days after");
    expect(boundsCall?.userPrompt).not.toContain("last day of the invoiced month");
  });

  it("sends every excerpt to the bounds call on a low-confidence pick", async () => {
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({
      termsJson: MISSING_BOUNDS_TERMS_JSON,
      clausePick: "e3",
      clauseConfidence: 0.5,
      orCalls,
    });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(undefined)));
    expect(receipt.blockedReasons.map((r) => r.reason)).toEqual(["terms_unconfirmed"]);
    expect(receipt.paymentTerms?.termClause?.narrowed).toBe(false);
    const boundsCall = orCalls.find((c) => c.schemaName === "term_bounds");
    expect(boundsCall?.userPrompt).toContain("commence on May 29, 2024");
    expect(boundsCall?.userPrompt).toContain("net 30 days after");
  });

  it("runs the bounds call over all excerpts without a TypeSafe connection", async () => {
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, orCalls });
    const { receipt } = await runGenericPipeline({
      ...config(reviewsDirWith(undefined)),
      connections: CONNECTIONS,
    });
    expect(receipt.blockedReasons.map((r) => r.reason)).toEqual(["terms_unconfirmed"]);
    expect(receipt.paymentTerms?.termClause).toBeUndefined();
    expect(receipt.typedCallDigests?.term_clause).toBeUndefined();
    const boundsCall = orCalls.find((c) => c.schemaName === "term_bounds");
    expect(boundsCall?.userPrompt).toContain("net 30 days after");
  });

  it("keeps needs_review with partialTerms when the bounds call fails validation", async () => {
    stubFetch({
      termsJson: MISSING_BOUNDS_TERMS_JSON,
      clausePick: "e3",
      boundsJson: { ...BOUNDS_JSON, term_end: { ...BOUNDS_JSON.term_end, quote: "not in the excerpt" } },
    });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(undefined)));
    expect(receipt.status).toBe("needs_review");
    const reasons = receipt.blockedReasons.map((r) => r.reason);
    expect(reasons).toContain("missing_term_bounds");
    const outcome = receipt.paymentTerms?.outcome;
    expect(outcome?.status).toBe("needs_review");
    if (outcome?.status === "needs_review") {
      // The blocked receipt still shows the terms the model read.
      expect(outcome.partialTerms?.terms).toHaveLength(3);
      expect(outcome.partialTerms?.terms[1]?.amountCents).toBe(500000);
    }
  });

  it("keeps needs_review when the bounds call still leaves a bound null", async () => {
    stubFetch({
      termsJson: MISSING_BOUNDS_TERMS_JSON,
      clausePick: "e3",
      boundsJson: { ...BOUNDS_JSON, term_end: null },
    });
    const { receipt } = await runGenericPipeline(config(reviewsDirWith(undefined)));
    expect(receipt.blockedReasons.map((r) => r.reason)).toContain("missing_term_bounds");
    const outcome = receipt.paymentTerms?.outcome;
    if (outcome?.status === "needs_review") {
      // The filled bound is merged into the partial terms.
      expect(outcome.partialTerms?.termStart?.iso).toBe("2024-05-29");
      expect(outcome.partialTerms?.termEnd).toBeNull();
      expect(outcome.partialTerms?.boundsFrom).toBe("term_bounds");
    }
  });

  it("carries the term-clause pick, bounds and merged extraction together", async () => {
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3" });
    const first = await runGenericPipeline(config(reviewsDirWith(REVIEW_JSON)));
    expect(first.receipt.status).toBe("reviewable");
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3", orCalls });
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
    expect(inc?.carriedForward).toEqual(
      expect.arrayContaining(["payment_terms", "term_clause", "term_bounds"]),
    );
    // Nothing called the model or Jev again.
    expect(orCalls).toEqual([]);
    expect(second.receipt.paymentTerms?.termClause?.carriedFrom).toBe(first.receipt.runId);
    expect(second.receipt.paymentTerms?.termBounds?.carriedFrom).toBe(first.receipt.runId);
    expect(second.receipt.typedCallDigests?.term_clause).toBe(
      first.receipt.typedCallDigests?.term_clause,
    );
    expect(second.receipt.typedCallDigests?.term_bounds).toBe(
      first.receipt.typedCallDigests?.term_bounds,
    );
    const outcome = second.receipt.paymentTerms?.outcome;
    if (outcome?.status === "extracted") {
      expect(outcome.terms.boundsFrom).toBe("term_bounds");
      expect(outcome.terms.boundsPick?.choice).toBe("e3");
    }
    // The cross-check carried too (payment_terms digest covers merged terms).
    expect(inc?.carriedForward).toContain("terms_crosscheck");
  });

  it("carries the payment-terms calls from the named needs_review run", async () => {
    // Run 1 ends at the review gate: extraction, clause pick, bounds and
    // cross-check all validated but no review file exists yet.
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3" });
    const first = await runGenericPipeline(config(reviewsDirWith(undefined)));
    expect(first.receipt.status).toBe("needs_review");
    expect(first.receipt.paymentTerms?.outcome.status).toBe("extracted");
    expect(first.receipt.paymentTerms?.termClause?.choice).toBe("e3");

    // The reviewer confirms that run's extraction in place.
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3", orCalls });
    const named = { extractedIn: first.receipt.runId, terms: REVIEW_JSON.terms };
    const second = await runGenericPipeline({
      ...config(reviewsDirWith(named)),
      runId: "run-test-2",
      previous: {
        runId: first.receipt.runId,
        receipt: first.receipt,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [{ runId: first.receipt.runId, receipt: first.receipt }],
    });

    expect(second.receipt.status).toBe("reviewable");
    expect(second.receipt.blockedReasons).toEqual([]);
    // All four calls carried; nothing asked the model or Jev again.
    const inc = second.receipt.incremental;
    expect(inc?.carriedForward).toEqual(
      expect.arrayContaining([
        "payment_terms",
        "term_clause",
        "term_bounds",
        "terms_crosscheck",
      ]),
    );
    expect(orCalls).toEqual([]);
    const outcome = second.receipt.paymentTerms?.outcome;
    if (outcome?.status === "extracted") {
      expect(outcome.carriedFrom).toBe(first.receipt.runId);
      expect(outcome.terms.boundsFrom).toBe("term_bounds");
    }
    expect(second.receipt.paymentTerms?.termClause?.carriedFrom).toBe(first.receipt.runId);
    expect(second.receipt.paymentTerms?.termBounds?.carriedFrom).toBe(first.receipt.runId);
    expect(second.receipt.paymentTerms?.crosscheck).toHaveLength(3);
    expect(second.receipt.paymentTerms?.confirmation?.status).toBe("confirmed");
    // The confirmation matched, so both readings ran on both workers.
    expect(second.receipt.readings.map((r) => r.id)).toEqual([
      "partial_months_prorated",
      "partial_months_not_billed",
    ]);
  });

  it("refuses to carry when the named run has a non-review blocker", async () => {
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3" });
    const first = await runGenericPipeline(config(reviewsDirWith(undefined)));
    const dirty = JSON.parse(JSON.stringify(first.receipt)) as typeof first.receipt;
    dirty.blockedReasons = [
      ...dirty.blockedReasons,
      { reason: "quote_not_verbatim", detail: "terms[2].quote is not verbatim" },
    ];
    const named = { extractedIn: first.receipt.runId, terms: REVIEW_JSON.terms };
    const second = await runGenericPipeline({
      ...config(reviewsDirWith(named)),
      runId: "run-test-2",
      previous: {
        runId: first.receipt.runId,
        receipt: dirty,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [{ runId: first.receipt.runId, receipt: dirty }],
    });
    expect(second.receipt.status).toBe("needs_review");
    const block = second.receipt.blockedReasons.find((r) => r.reason === "terms_unconfirmed");
    expect(block?.detail).toContain("extractedIn");
    expect(block?.detail).toContain("quote_not_verbatim");
    expect(second.receipt.incremental?.carriedForward ?? []).not.toContain("payment_terms");
  });

  it("refuses to carry when a named-run digest does not match", async () => {
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3" });
    const first = await runGenericPipeline(config(reviewsDirWith(undefined)));
    const dirty = JSON.parse(JSON.stringify(first.receipt)) as typeof first.receipt;
    if (dirty.typedCallDigests !== undefined) {
      dirty.typedCallDigests.term_bounds = "0".repeat(64);
    }
    const named = { extractedIn: first.receipt.runId, terms: REVIEW_JSON.terms };
    const second = await runGenericPipeline({
      ...config(reviewsDirWith(named)),
      runId: "run-test-2",
      previous: {
        runId: first.receipt.runId,
        receipt: dirty,
        sourceTuple: first.sourceTuple,
      },
      carrySources: [{ runId: first.receipt.runId, receipt: dirty }],
    });
    const block = second.receipt.blockedReasons.find((r) => r.reason === "terms_unconfirmed");
    expect(block?.detail).toContain("term_bounds digest does not match");
  });

  it("does not carry from a needs_review source when the file names no extractedIn", async () => {
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3" });
    const first = await runGenericPipeline(config(reviewsDirWith(undefined)));
    const orCalls: { schemaName: string; userPrompt: string }[] = [];
    stubFetch({ termsJson: MISSING_BOUNDS_TERMS_JSON, clausePick: "e3", orCalls });
    // Same review entries, but no extractedIn: normal carry rules apply and a
    // needs_review source lends nothing — the extraction reruns.
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
    expect(second.receipt.incremental?.carriedForward ?? []).not.toContain("payment_terms");
    expect(second.receipt.incremental?.reran ?? []).toContain("payment_terms");
    // The fresh extraction emits the same terms, so confirmation still passes.
    expect(second.receipt.paymentTerms?.confirmation?.status).toBe("confirmed");
    expect(second.receipt.status).toBe("reviewable");
    expect(orCalls.map((c) => c.schemaName)).toContain("payment_terms");
  });
});



// Same fake as stubFetch but returned for composition.
function stubFetchImpl(): typeof fetch {
  stubFetch();
  return globalThis.fetch;
}
