import { describe, expect, it } from "vitest";
import { OpenRouterScheduleExtractor, SCHEDULE_JSON_SCHEMA, validateScheduleExtraction } from "./schedule.ts";
import type { Excerpt } from "./types.ts";

const EXCERPTS: Excerpt[] = [
  {
    id: "ex-terms",
    text: "Consultant is paid $5,000 per month for a 2-month period.",
    source: { fileName: "doc.pdf", versionLabel: "sha256 aabbccddeeff", page: 1, section: "§3(a)" },
  },
  {
    id: "ex-r1",
    text: "$5,000 shall be paid to Consultant on January 2, 2027.",
    source: { fileName: "doc.pdf", versionLabel: "sha256 aabbccddeeff", page: 2, section: "§3(b)(i)" },
  },
  {
    id: "ex-r2",
    text: "If the term is extended until February 28, 2027, $5,000 shall be paid to Consultant on February 2, 2027.",
    source: { fileName: "doc.pdf", versionLabel: "sha256 aabbccddeeff", page: 2, section: "§3(b)(ii)" },
  },
];

function validExtraction(): Record<string, unknown> {
  return {
    monthly_amount: { text: "$5,000", excerpt_id: "ex-terms", quote: "$5,000 per month" },
    period: { text: "2-month", excerpt_id: "ex-terms", quote: "a 2-month period" },
    releases: [
      {
        amount_text: "$5,000",
        date_text: "February 2, 2027",
        condition_text: "until February 28, 2027",
        excerpt_id: "ex-r2",
        quote:
          "If the term is extended until February 28, 2027, $5,000 shall be paid to Consultant on February 2, 2027.",
      },
      {
        amount_text: "$5,000",
        date_text: "January 2, 2027",
        condition_text: null,
        excerpt_id: "ex-r1",
        quote: "$5,000 shall be paid to Consultant on January 2, 2027.",
      },
    ],
    confidence: 0.9,
  };
}

describe("validateScheduleExtraction", () => {
  it("accepts a valid extraction and numbers releases by document position", () => {
    const result = validateScheduleExtraction(validExtraction(), EXCERPTS, 0.8);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.monthlyAmountCents).toBe(500000);
    expect(result.schedule.periodMonths).toBe(2);
    // The conditional release was listed first by the model but is still
    // numbered after the unconditional one, by document position.
    expect(result.schedule.releases.map((r) => r.id)).toEqual(["release-1", "release-ext-1"]);
    const [r1, r2] = result.schedule.releases;
    expect(r1?.date).toBe("2027-01-02");
    expect(r1?.conditional).toBe(false);
    expect(r2?.date).toBe("2027-02-02");
    expect(r2?.conditional).toBe(true);
    expect(r2?.extensionId).toBe("ext-2027-02-28");
  });

  it("rejects non-object and key-mismatched payloads", () => {
    expect(validateScheduleExtraction([], EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
    const missing = validExtraction();
    delete missing.period;
    expect(validateScheduleExtraction(missing, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
    const extra = validExtraction();
    (extra.monthly_amount as Record<string, unknown>).extra = 1;
    expect(validateScheduleExtraction(extra, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
  });

  it("rejects releases arrays outside 1..8 items", () => {
    const empty = validExtraction();
    empty.releases = [];
    expect(validateScheduleExtraction(empty, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
    const many = validExtraction();
    const r = (many.releases as unknown[])[0];
    many.releases = Array.from({ length: 9 }, () => r);
    expect(validateScheduleExtraction(many, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "schema_mismatch",
    });
  });

  it("rejects an unknown excerpt id", () => {
    const bad = validExtraction();
    (bad.releases as { excerpt_id: string }[])[0]!.excerpt_id = "ex-nope";
    expect(validateScheduleExtraction(bad, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "unknown_excerpt",
    });
  });

  it("rejects a quote that is not verbatim in the excerpt", () => {
    const bad = validExtraction();
    (bad.monthly_amount as { quote: string }).quote = "$9,999 per month";
    expect(validateScheduleExtraction(bad, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "quote_not_verbatim",
    });
  });

  it("rejects a text that is not verbatim inside its quote", () => {
    const bad = validExtraction();
    (bad.monthly_amount as { text: string }).text = "$6,000";
    expect(validateScheduleExtraction(bad, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "quote_not_verbatim",
    });
  });

  it("accepts quotes that are verbatim only after whitespace normalisation", () => {
    const ok = validExtraction();
    (ok.releases as { quote: string }[])[1]!.quote =
      "$5,000 shall be paid  to\nConsultant on January 2, 2027.";
    expect(validateScheduleExtraction(ok, EXCERPTS, 0.8).ok).toBe(true);
  });

  it("rejects malformed amounts, dates, periods and conditions", () => {
    // The verbatim chain runs before format parsing, so the malformed values
    // must still be verbatim inside a quote that is verbatim in an excerpt.
    const odd: Excerpt = {
      id: "ex-odd",
      text: "weird terms: paid 5000 monthly, a two months period; paid $5,00,0 odd on February 2, 2027 if extended somehow; $5,000 on 2027-02-02 if extended somehow; $5,000 on February 2, 2027 if extended somehow.",
      source: { fileName: "odd.pdf", versionLabel: "v", page: 1 },
    };
    const excerpts = [odd, ...EXCERPTS];
    const releases = () =>
      [
        {
          amount_text: "$5,00,0",
          date_text: "February 2, 2027",
          condition_text: "if extended somehow",
          excerpt_id: "ex-odd",
          quote: "paid $5,00,0 odd on February 2, 2027 if extended somehow",
        },
        (validExtraction().releases as unknown[])[1],
      ] as unknown[];
    const cases: [string, (e: Record<string, unknown>) => void][] = [
      [
        "monthly amount",
        (e) => {
          e.monthly_amount = { text: "5000", excerpt_id: "ex-odd", quote: "paid 5000 monthly" };
        },
      ],
      ["release amount", () => undefined], // the releases() default is the malformed case
      [
        "release date",
        (e) => {
          (e.releases as Record<string, unknown>[])[0] = {
            amount_text: "$5,000",
            date_text: "2027-02-02",
            condition_text: "if extended somehow",
            excerpt_id: "ex-odd",
            quote: "$5,000 on 2027-02-02 if extended somehow",
          };
        },
      ],
      [
        "period",
        (e) => {
          e.period = { text: "two months", excerpt_id: "ex-odd", quote: "a two months period" };
        },
      ],
      [
        "condition",
        (e) => {
          (e.releases as Record<string, unknown>[])[0] = {
            amount_text: "$5,000",
            date_text: "February 2, 2027",
            condition_text: "if extended somehow",
            excerpt_id: "ex-odd",
            quote: "$5,000 on February 2, 2027 if extended somehow",
          };
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const bad = validExtraction();
      bad.releases = releases();
      mutate(bad);
      expect(validateScheduleExtraction(bad, excerpts, 0.8), label).toMatchObject({
        ok: false,
        reason: "schema_mismatch",
      });
    }
  });

  it("parses a Month D YYYY date without the comma", () => {
    const ok = validExtraction();
    (ok.releases as Record<string, unknown>[])[0] = {
      amount_text: "$5,000",
      date_text: "February 2 2027",
      condition_text: "until February 28 2027",
      excerpt_id: "ex-r2b",
      quote: "If the term is extended until February 28 2027, $5,000 shall be paid to Consultant on February 2 2027.",
    };
    const excerpts = [
      ...EXCERPTS.slice(0, 2),
      {
        id: "ex-r2b",
        text: "If the term is extended until February 28 2027, $5,000 shall be paid to Consultant on February 2 2027.",
        source: { fileName: "doc.pdf", versionLabel: "v", page: 2 },
      },
    ];
    const result = validateScheduleExtraction(ok, excerpts, 0.8);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.releases[1]?.date).toBe("2027-02-02");
      expect(result.schedule.releases[1]?.extensionId).toBe("ext-2027-02-28");
    }
  });

  it("rejects low self-reported confidence", () => {
    const bad = validExtraction();
    bad.confidence = 0.5;
    expect(validateScheduleExtraction(bad, EXCERPTS, 0.8)).toMatchObject({
      ok: false,
      reason: "low_confidence",
    });
  });

  it("rejects monthly x months != sum of releases as inconsistent_terms", () => {
    const bad = validExtraction();
    (bad.period as { text: string; quote: string }).text = "3-month";
    (bad.period as { text: string; quote: string }).quote = "a 3-month period";
    const excerpts = [
      {
        id: "ex-terms",
        text: "Consultant is paid $5,000 per month for a 3-month period.",
        source: { fileName: "doc.pdf", versionLabel: "v", page: 1 },
      },
      ...EXCERPTS.slice(1),
    ];
    expect(validateScheduleExtraction(bad, excerpts, 0.8)).toMatchObject({
      ok: false,
      reason: "inconsistent_terms",
    });
  });
});

describe("OpenRouterScheduleExtractor", () => {
  const envelope = (payload: unknown, extra: Record<string, unknown> = {}) => ({
    model: "resolved-model",
    provider: "Nvidia",
    choices: [
      { message: { content: JSON.stringify(payload) }, finish_reason: "stop" },
    ],
    ...extra,
  });

  function stubFetch(body: unknown, init: { status?: number } = {}) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = ((url: unknown, initObj?: unknown) => {
      calls.push({ url: String(url), init: initObj as RequestInit | undefined });
      return Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    return { impl, calls };
  }

  it("sends the strict schedule schema and returns a validated schedule", async () => {
    const { impl, calls } = stubFetch(envelope(validExtraction()));
    const extractor = new OpenRouterScheduleExtractor({
      gatewayBaseUrl: "http://gw.invalid",
      fetch: impl,
    });
    const outcome = await extractor.extract({ id: "escrow_schedule", excerpts: EXCERPTS });
    expect(outcome.status).toBe("extracted");
    if (outcome.status !== "extracted") return;
    expect(outcome.schedule.releases.map((r) => r.id)).toEqual(["release-1", "release-ext-1"]);
    expect(outcome.modelVersion).toBe("resolved-model");
    expect(outcome.servedBy).toBe("Nvidia");

    const request = calls[0];
    expect(request?.url).toBe("http://gw.invalid/v1/chat/completions");
    const requestBody = request?.init?.body;
    expect(typeof requestBody).toBe("string");
    const body = JSON.parse(requestBody as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.provider).toEqual({ require_parameters: true });
    const rf = body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("schedule_extraction");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(SCHEDULE_JSON_SCHEMA);
    const headers = (request?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("maps a 429 to rate_limited", async () => {
    const { impl } = stubFetch({ error: { code: 429, message: "slow down" } }, { status: 429 });
    const extractor = new OpenRouterScheduleExtractor({
      gatewayBaseUrl: "http://gw.invalid",
      fetch: impl,
    });
    const outcome = await extractor.extract({ id: "escrow_schedule", excerpts: EXCERPTS });
    expect(outcome.status).toBe("needs_review");
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("rate_limited");
  });

  it("maps a validation failure to needs_review with the reason", async () => {
    const bad = validExtraction();
    bad.confidence = 0.1;
    const { impl } = stubFetch(envelope(bad));
    const extractor = new OpenRouterScheduleExtractor({
      gatewayBaseUrl: "http://gw.invalid",
      fetch: impl,
    });
    const outcome = await extractor.extract({ id: "escrow_schedule", excerpts: EXCERPTS });
    expect(outcome.status).toBe("needs_review");
    if (outcome.status === "needs_review") expect(outcome.reason).toBe("low_confidence");
  });
});
