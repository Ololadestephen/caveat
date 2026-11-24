import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runPipeline } from "./run-pipeline.ts";

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

// One escrow section; the quotes below are verbatim substrings of this text.
const OPERATIVE_TEXT =
  "3. Transaction Compensation The Consultant shall be paid $6,000 per month " +
  "for the 6-month period into escrow. (i) $36,000 shall be released to the " +
  "consultant on January 2, 2027.";

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

// fetch router: Box REST calls by URL, chat calls by schema name in the body.
function stubFetch(): void {
  const impl = (url: unknown, init?: unknown): Promise<Response> => {
    const u = String(url);
    const body = (init as { body?: unknown } | undefined)?.body;
    const schema =
      typeof body === "string"
        ? (JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } })
            .response_format?.json_schema?.name
        : undefined;

    if (u === `${OR}/v1/chat/completions`) {
      return Promise.resolve(
        schema === "release_timing_decision"
          ? chatResponse(DECISION_JSON)
          : chatResponse(SCHEDULE_JSON),
      );
    }
    if (u.startsWith(`${BOX}/2.0/folders/0/items`)) {
      return Promise.resolve(
        jsonResponse({ entries: [{ id: "F1", type: "folder", name: "caveat_TEST" }] }),
      );
    }
    if (u.startsWith(`${BOX}/2.0/folders/F1/items`)) {
      return Promise.resolve(
        jsonResponse({
          entries: FILE_NAMES.map((name, i) => ({ id: `file-${i}`, type: "file", name })),
        }),
      );
    }
    const content = u.match(/\/2\.0\/files\/(file-\d)\/content/);
    if (content !== null) {
      return Promise.resolve(new Response(fileBytes(content[1]!), { status: 200 }));
    }
    const meta = u.match(/\/2\.0\/files\/(file-\d)\?/);
    if (meta !== null) {
      const bytes = fileBytes(meta[1]!);
      return Promise.resolve(
        jsonResponse({
          id: meta[1],
          name: FILE_NAMES[Number(meta[1]!.slice(5))],
          size: bytes.byteLength,
          sha1: createHash("sha1").update(bytes).digest("hex"),
          file_version: { id: "v1" },
          modified_at: "2026-01-01T00:00:00Z",
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  vi.stubGlobal("fetch", impl);
}

function fileBytes(id: string): Uint8Array {
  return new TextEncoder().encode(`pdf-bytes-${id}`);
}

// The pdfText seam: canned page lines per byte payload.
function cannedPdfLines(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const lines = text.includes("file-2")
    ? ["3. Transaction Compensation", "The Consultant shall be paid $6,000 per month", "for the 6-month period into escrow.", "(i) $36,000 shall be released to the", "consultant on January 2, 2027."]
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
