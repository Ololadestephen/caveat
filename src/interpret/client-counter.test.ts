import { describe, expect, it } from "vitest";
import {
  OpenRouterClientCounterExtractor,
  validateClientCounter,
} from "./client-counter.ts";
import type { Excerpt } from "./types.ts";

const SECTION2 =
  "2. Counterproposal We propose that $3,000 of the escrow funding be paid to you as an upfront deposit on October 1, 2026, with the January 2, 2027 release reduced by the same amount.";

const EXCERPTS: Excerpt[] = [
  {
    id: "04-client-reply.pdf#§2",
    text: SECTION2,
    source: {
      fileName: "04-client-reply.pdf",
      versionLabel: "sha256 abc123",
      page: 1,
      section: "§2",
    },
  },
];

const VALID = {
  readable: true,
  lever: "upfront_deposit",
  amount_text: "$3,000",
  date_text: "October 1, 2026",
  split_count_text: null,
  net_days_text: null,
  excerpt_id: "04-client-reply.pdf#§2",
  quote:
    "We propose that $3,000 of the escrow funding be paid to you as an upfront deposit on October 1, 2026",
  unclear_note: null,
  confidence: 0.95,
};

const validate = (raw: unknown) => validateClientCounter(raw, EXCERPTS, 0.8);
const reasonOf = (raw: unknown) => {
  const out = validate(raw);
  return out.ok ? "ok" : out.reason;
};

// Validate raw against a one-excerpt list whose text is given verbatim; the
// raw's excerpt_id points at that excerpt.
const against = (text: string, raw: Record<string, unknown>) =>
  validateClientCounter(
    { ...raw, excerpt_id: "E" },
    [
      {
        id: "E",
        text,
        source: {
          fileName: "04-client-reply.pdf",
          versionLabel: "sha256 abc123",
          page: 1,
          section: "§2",
        },
      },
    ],
    0.8,
  );
const reasonAgainst = (text: string, raw: Record<string, unknown>) => {
  const out = against(text, raw);
  return out.ok ? "ok" : out.reason;
};

describe("validateClientCounter", () => {
  it("accepts a verbatim readable counter and parses every field", () => {
    const out = validate(VALID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate).toEqual({
      lever: "upfront_deposit",
      amount_cents: 300000,
      date: "2026-10-01",
      split_count: null,
      net_days: null,
      rationale: "client counter",
    });
    expect(out.citation).toEqual({
      excerptId: "04-client-reply.pdf#§2",
      quote: VALID.quote,
      page: 1,
    });
  });

  it("rejects a non-object and a bad lever as schema_mismatch", () => {
    expect(reasonOf("nope")).toBe("schema_mismatch");
    expect(reasonOf({ ...VALID, lever: "gold_watch" })).toBe("schema_mismatch");
    expect(reasonOf({ ...VALID, extra_key: 1 })).toBe("schema_mismatch");
    expect(reasonOf({ ...VALID, readable: "yes" })).toBe("schema_mismatch");
  });

  it("routes readable=false to counter_unreadable with the model's note", () => {
    const out = validate({
      ...VALID,
      readable: false,
      lever: null,
      amount_text: null,
      date_text: null,
      excerpt_id: null,
      quote: null,
      unclear_note: "the letter proposes two different changes",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("counter_unreadable");
    expect(out.detail).toBe("the letter proposes two different changes");
  });

  it("rejects an excerpt_id that was never supplied", () => {
    const out = validate({ ...VALID, excerpt_id: "04-client-reply.pdf#§9" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unknown_excerpt");
    expect(out.detail).toContain("§9");
  });

  it("rejects a quote that is not verbatim in its excerpt", () => {
    expect(reasonOf({ ...VALID, quote: "We propose that $4,000 be paid." })).toBe(
      "quote_not_verbatim",
    );
  });

  it("rejects a copied field that is not inside the quote", () => {
    expect(reasonOf({ ...VALID, amount_text: "$9,999" })).toBe("quote_not_verbatim");
  });

  it("requires the fields its lever needs (missing_field)", () => {
    // milestone_split needs amount_text, date_text AND split_count_text.
    expect(reasonOf({ ...VALID, lever: "milestone_split" })).toBe("missing_field");
    // shorter_payment_terms needs only net_days_text.
    const netText = "2. Counterproposal We propose fees released 30 days after the month ends.";
    expect(
      reasonAgainst(netText, {
        ...VALID,
        lever: "shorter_payment_terms",
        amount_text: null,
        date_text: null,
        quote: "We propose fees released 30 days after the month ends.",
      }),
    ).toBe("missing_field");
  });

  it("rejects fields its lever does not take (unexpected_field)", () => {
    const text =
      "2. Counterproposal We propose fees released 30 days after the month ends, in two monthly parts.";
    const quote = "fees released 30 days after the month ends, in two monthly parts";
    expect(
      reasonAgainst(text, {
        ...VALID,
        lever: "shorter_payment_terms",
        amount_text: null,
        date_text: null,
        net_days_text: "30 days",
        split_count_text: "two",
        quote,
      }),
    ).toBe("unexpected_field");
    // upfront_deposit takes amount+date only; a verbatim split count is extra.
    expect(
      reasonAgainst(
        "2. Counterproposal We propose that $3,000 be paid in two parts on October 1, 2026.",
        {
          ...VALID,
          split_count_text: "two",
          quote: "We propose that $3,000 be paid in two parts on October 1, 2026.",
        },
      ),
    ).toBe("unexpected_field");
  });

  it("rejects unparseable copied text per field", () => {
    // amount_text verbatim in the quote but not a dollar figure.
    expect(
      reasonAgainst(
        "2. Counterproposal We propose that three thousand dollars of the funding be paid on October 1, 2026.",
        {
          ...VALID,
          amount_text: "three thousand dollars",
          quote: "We propose that three thousand dollars of the funding be paid on October 1, 2026.",
        },
      ),
    ).toBe("parse_amount");
    // date_text verbatim in the quote but not "Month D, YYYY".
    expect(
      reasonAgainst("2. Counterproposal We propose that $3,000 be paid on October 1st.", {
        ...VALID,
        date_text: "October 1st",
        quote: "We propose that $3,000 be paid on October 1st.",
      }),
    ).toBe("parse_date");
    // split_count_text verbatim but not 2/3/two/three.
    expect(
      reasonAgainst(
        "2. Counterproposal We propose that $6,000 be paid in four monthly parts, the first on November 2, 2026.",
        {
          ...VALID,
          lever: "milestone_split",
          amount_text: "$6,000",
          date_text: "November 2, 2026",
          split_count_text: "four",
          quote: "We propose that $6,000 be paid in four monthly parts, the first on November 2, 2026.",
        },
      ),
    ).toBe("parse_split_count");
    // net_days_text verbatim but out of range / malformed.
    expect(
      reasonAgainst("2. Counterproposal We propose fees released 120 days after.", {
        ...VALID,
        lever: "shorter_payment_terms",
        amount_text: null,
        date_text: null,
        net_days_text: "120 days",
        quote: "fees released 120 days after",
      }),
    ).toBe("parse_net_days");
  });

  it("parses split counts two/three and net days 1-90", () => {
    const splitText =
      "2. Counterproposal We propose that $6,000 be paid in two monthly parts, the first on November 2, 2026.";
    const splitRaw = {
      ...VALID,
      lever: "milestone_split",
      amount_text: "$6,000",
      date_text: "November 2, 2026",
      split_count_text: "two",
      quote: "We propose that $6,000 be paid in two monthly parts, the first on November 2, 2026.",
    };
    const two = against(splitText, splitRaw);
    expect(two.ok).toBe(true);
    if (two.ok) {
      expect(two.candidate.split_count).toBe(2);
      expect(two.candidate.amount_cents).toBe(600000);
      expect(two.candidate.date).toBe("2026-11-02");
    }
    const three = against(splitText.replace("two", "3"), {
      ...splitRaw,
      split_count_text: "3",
      quote: "We propose that $6,000 be paid in 3 monthly parts, the first on November 2, 2026.",
    });
    expect(three.ok).toBe(true);
    if (three.ok) expect(three.candidate.split_count).toBe(3);

    const netText = "2. Counterproposal We propose fees released 45 after the month ends.";
    const bare = against(netText, {
      ...VALID,
      lever: "shorter_payment_terms",
      amount_text: null,
      date_text: null,
      net_days_text: "45",
      quote: "fees released 45 after the month ends",
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.candidate.net_days).toBe(45);
  });

  it("rejects low confidence", () => {
    const out = validate({ ...VALID, confidence: 0.5 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("low_confidence");
    expect(out.detail).toContain("0.5");
  });
});

describe("OpenRouterClientCounterExtractor", () => {
  const chatResponse = (content: unknown): Response =>
    new Response(
      JSON.stringify({
        model: "test-model-v1",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("extracts a valid counter through the chat seam", async () => {
    const extractor = new OpenRouterClientCounterExtractor({
      gatewayBaseUrl: "https://gw.test",
      model: "m",
      fetch: () => Promise.resolve(chatResponse(VALID)),
    });
    const out = await extractor.extract({ id: "client_counter", excerpts: EXCERPTS });
    expect(out.status).toBe("extracted");
    if (out.status !== "extracted") return;
    expect(out.candidate.amount_cents).toBe(300000);
    expect(out.citation.quote).toBe(VALID.quote);
  });

  it("returns needs_review on a model/http error", async () => {
    const extractor = new OpenRouterClientCounterExtractor({
      gatewayBaseUrl: "https://gw.test",
      model: "m",
      fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    const out = await extractor.extract({ id: "client_counter", excerpts: EXCERPTS });
    expect(out.status).toBe("needs_review");
  });
});
