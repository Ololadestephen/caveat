import { describe, expect, it, vi } from "vitest";

import {
  JEV_MODEL,
  JevDecisionProvider,
  buildReleaseTimingDigestInput,
} from "./jev.ts";
import { digestValue } from "../runner/digest.ts";
import { RELEASE_TIMING } from "./types.ts";
import type { ValidatedRelease } from "./schedule.ts";
import type { ValidatedTerm } from "./payment-terms.ts";
import type { Excerpt, Question } from "./types.ts";

const EXCERPTS: Excerpt[] = [
  {
    id: "03-second-amendment.pdf#§3(b)",
    text: "compensation for the entire 6-month period shall be paid into an escrow account",
    source: { fileName: "03-second-amendment.pdf", versionLabel: "v1", page: 2, section: "§3(b)" },
  },
  {
    id: "03-second-amendment.pdf#§3(b)(i)",
    text: "$75,000 shall be paid to Consultant on January 2, 2027.",
    source: { fileName: "03-second-amendment.pdf", versionLabel: "v1", page: 2, section: "§3(b)(i)" },
  },
];

const QUESTION: Question = {
  spec: RELEASE_TIMING,
  id: "release_timing",
  excerpts: EXCERPTS,
};

const ACTION_KEYS = [
  "cash_on_fixed_date",
  "escrow_release",
  "transaction_triggered",
  "ambiguous",
];

const SOURCE_INSTRUCTIONS: Record<string, string> = {
  cash_on_fixed_date:
    "Which excerpt states the first calendar date on which cash is paid directly to the Consultant?",
  escrow_release:
    "Which excerpt states the date of the first release of escrowed money to the Consultant that does not depend on any extension or other condition?",
  transaction_triggered:
    "Which excerpt states the transaction event that triggers payment to the Consultant?",
};

function choice(choice: string, confidence: number, keys: string[]) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === choice ? confidence : (1 - confidence) / (keys.length - 1)]),
    ),
  };
}

function jevResponse(answers: Record<string, unknown>, model = JEV_MODEL) {
  return new Response(
    JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 5 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const DECIDED_ANSWERS = {
  release_timing: choice("escrow_release", 0.92, ACTION_KEYS),
  release_timing_source: choice("e2", 0.87, ["e1", "e2"]),
};

function provider(fetchImpl: typeof fetch): JevDecisionProvider {
  return new JevDecisionProvider({ gatewayBaseUrl: "http://ts.test/", fetch: fetchImpl });
}

type JevBody = {
  model: string;
  state: { excerpts: { key: string; section: string; text: string }[] };
  questions: Record<
    string,
    { type: string; instructions: string; criteria?: Record<string, string> }
  >;
};

function bodies(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): JevBody[] {
  return fetchImpl.mock.calls.map((call) => {
    const init = call[1];
    return JSON.parse((init as { body: string }).body) as JevBody;
  });
}

function lastBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): JevBody {
  return bodies(fetchImpl).at(-1) as JevBody;
}

// Routes each systemone request by the question it carries; both fields hold
// the full canned answers map, and the router picks per request.
function routingFetch(
  answers: Record<string, unknown>,
  overrides?: {
    timingResponse?: Response;
    sourceResponse?: Response;
  },
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    const body = JSON.parse(
      (init as { body: string }).body,
    ) as { questions: Record<string, unknown> };
    if ("release_timing" in body.questions) {
      const res = overrides?.timingResponse;
      if (res !== undefined) return Promise.resolve(res);
      return Promise.resolve(
        jevResponse({ release_timing: answers.release_timing }),
      );
    }
    if ("release_timing_source" in body.questions) {
      const res = overrides?.sourceResponse;
      if (res !== undefined) return Promise.resolve(res);
      return Promise.resolve(
        jevResponse({ release_timing_source: answers.release_timing_source }),
      );
    }
    return Promise.resolve(jevResponse(answers));
  });
}

describe("JevDecisionProvider.decide", () => {
  it("decided: maps the action, cites the source excerpt, keeps probabilities", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS);
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("decided");
    if (out.status !== "decided") return;
    expect(out.provider).toBe("typesafe");
    expect(out.model).toBe(JEV_MODEL);
    expect(out.decision.action).toBe("escrow_release");
    expect(out.decision.cited_clause.excerpt_id).toBe("03-second-amendment.pdf#§3(b)(i)");
    expect(out.decision.cited_clause.quote).toBe(EXCERPTS[1]?.text);
    expect(out.decision.confidence).toBe(0.92);
    expect(out.jev?.questions.release_timing?.choice).toBe("escrow_release");
    expect(out.jev?.questions.release_timing?.model).toBe(JEV_MODEL);
    expect(out.jev?.questions.release_timing?.usage?.input_tokens).toBe(100);
    expect(out.jev?.questions.release_timing_source?.choice).toBe("e2");
    expect(out.jev?.questions.release_timing_source?.usage?.input_tokens).toBe(100);

    const [first, second] = bodies(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first?.model).toBe(JEV_MODEL);
    expect(Object.keys(first?.questions ?? {})).toEqual(["release_timing"]);
    expect(first?.questions.release_timing?.type).toBe("choice");
    expect(Object.keys(first?.questions.release_timing?.criteria ?? {})).toEqual(
      ACTION_KEYS,
    );
    expect(Object.keys(second?.questions ?? {})).toEqual([
      "release_timing_source",
    ]);
    expect(second?.questions.release_timing_source?.instructions).toBe(
      SOURCE_INSTRUCTIONS.escrow_release,
    );
    expect(second?.questions.release_timing_source?.criteria).toEqual({
      e1: "Excerpt e1 (§3(b))",
      e2: "Excerpt e2 (§3(b)(i))",
    });
    expect(second?.state.excerpts.map((e) => e.key)).toEqual(["e1", "e2"]);
  });

  it("ambiguous action → needs_review ambiguous, no second request", async () => {
    const fetchImpl = routingFetch({
      ...DECIDED_ANSWERS,
      release_timing: choice("ambiguous", 0.95, ACTION_KEYS),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("ambiguous");
    expect(out.jev?.questions.release_timing?.probabilities.ambiguous).toBeCloseTo(0.95);
    expect(out.jev?.questions.release_timing_source).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("low confidence on the action question → low_confidence, no second request", async () => {
    const fetchImpl = routingFetch({
      ...DECIDED_ANSWERS,
      release_timing: choice("escrow_release", 0.7, ACTION_KEYS),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("low_confidence");
    expect(out.detail).toContain("release_timing");
    expect(out.jev?.questions.release_timing_source).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the citation instructions differ by chosen action", async () => {
    for (const action of [
      "cash_on_fixed_date",
      "escrow_release",
      "transaction_triggered",
    ]) {
      const fetchImpl = routingFetch({
        ...DECIDED_ANSWERS,
        release_timing: choice(action, 0.92, ACTION_KEYS),
      });
      const out = await provider(fetchImpl).decide(QUESTION);
      expect(out.status).toBe("decided");
      expect(lastBody(fetchImpl).questions.release_timing_source?.instructions).toBe(
        SOURCE_INSTRUCTIONS[action],
      );
    }
  });

  it("low confidence on the citation question → low_confidence naming it", async () => {
    const fetchImpl = routingFetch({
      ...DECIDED_ANSWERS,
      release_timing_source: choice("e1", 0.5, ["e1", "e2"]),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("low_confidence");
    expect(out.detail).toContain("release_timing_source");
    // Both requests ran; the decision question's answer is still recorded.
    expect(out.jev?.questions.release_timing?.choice).toBe("escrow_release");
    expect(out.jev?.questions.release_timing_source?.confidence).toBe(0.5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a different response model is model_mismatch", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS, {
      timingResponse: jevResponse(
        { release_timing: DECIDED_ANSWERS.release_timing },
        "jev-1.13.0",
      ),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("model_mismatch");
    expect(out.detail).toContain("jev-1.13.0");
  });

  it("a model mismatch on the citation request is still model_mismatch", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS, {
      sourceResponse: jevResponse(
        { release_timing_source: DECIDED_ANSWERS.release_timing_source },
        "jev-1.13.0",
      ),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("model_mismatch");
    expect(out.jev?.questions.release_timing).toBeDefined();
    expect(out.jev?.questions.release_timing_source).toBeUndefined();
  });

  it("an HTTP error maps to http_error", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS, {
      timingResponse: new Response("bad", { status: 500 }),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("http_error");
    expect(out.detail).toContain("500");
  });

  it("a missing decision answer key is schema_mismatch", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS, {
      timingResponse: jevResponse({}),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("schema_mismatch");
    expect(out.detail).toContain("release_timing");
  });

  it("a missing citation answer key is schema_mismatch", async () => {
    const fetchImpl = routingFetch(DECIDED_ANSWERS, {
      sourceResponse: jevResponse({}),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("schema_mismatch");
    expect(out.detail).toContain("release_timing_source");
  });

  it("an unknown choice key is schema_mismatch", async () => {
    const fetchImpl = routingFetch({
      ...DECIDED_ANSWERS,
      release_timing_source: choice("e9", 0.9, ["e1", "e2", "e9"]),
    });
    const out = await provider(fetchImpl).decide(QUESTION);
    expect(out.status).toBe("needs_review");
    if (out.status !== "needs_review") return;
    expect(out.reason).toBe("schema_mismatch");
  });
});

describe("buildReleaseTimingDigestInput", () => {
  it("covers both questions including all three citation instructions", () => {
    const input = buildReleaseTimingDigestInput(QUESTION, JEV_MODEL);
    const text = JSON.stringify(input);
    for (const instructions of Object.values(SOURCE_INSTRUCTIONS)) {
      expect(text).toContain(instructions);
    }
    expect(text).toContain("release_timing");
    expect(text).toContain("release_timing_source");
    // The excerpts' state is covered too.
    expect(text).toContain(EXCERPTS[0]?.text);
  });

  it("changes with the excerpts and with the model", () => {
    const base = digestValue(buildReleaseTimingDigestInput(QUESTION, JEV_MODEL));
    const otherModel = digestValue(
      buildReleaseTimingDigestInput(QUESTION, "jev-1.13.0"),
    );
    expect(otherModel).not.toBe(base);
    const otherExcerpts = digestValue(
      buildReleaseTimingDigestInput(
        {
          ...QUESTION,
          excerpts: [{ ...EXCERPTS[0] as Excerpt, text: "different text" }, EXCERPTS[1] as Excerpt],
        },
        JEV_MODEL,
      ),
    );
    expect(otherExcerpts).not.toBe(base);
  });
});

describe("JevDecisionProvider.gateLetter", () => {
  const noulAnswers = (noul: number) => ({
    single_payment_change: { type: "noul", noul },
  });

  it("noul >= 0.8 passes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jevResponse(noulAnswers(0.97)));
    const out = await provider(fetchImpl).gateLetter(EXCERPTS);
    expect(out.status).toBe("pass");
    if (out.status === "pass") {
      expect(out.gate.noul).toBe(0.97);
      expect(out.gate.model).toBe(JEV_MODEL);
      expect(out.gate.usage?.input_tokens).toBe(100);
    }
    const body = lastBody(fetchImpl);
    expect(body.questions.single_payment_change?.type).toBe("noul");
  });

  it("noul <= 0.2 is not_single", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jevResponse(noulAnswers(0.1)));
    const out = await provider(fetchImpl).gateLetter(EXCERPTS);
    expect(out.status).toBe("not_single");
    if (out.status === "not_single") expect(out.gate.noul).toBe(0.1);
  });

  it("in between is uncertain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jevResponse(noulAnswers(0.5)));
    const out = await provider(fetchImpl).gateLetter(EXCERPTS);
    expect(out.status).toBe("uncertain");
  });

  it("a failed call reports the reason", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("denied", { status: 403 }));
    const out = await provider(fetchImpl).gateLetter(EXCERPTS);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.reason).toBe("http_error");
  });
});

describe("JevDecisionProvider cross-checks", () => {
  const release = (
    id: string,
    conditional: boolean,
    quote: string,
  ): ValidatedRelease => ({
    id,
    conditional,
    extensionId: conditional ? "ext-2027-01-02" : undefined,
    amountText: "$75,000",
    amountCents: 7500000,
    dateText: "January 2, 2027",
    date: "2027-01-02",
    conditionText: conditional ? "if this Amendment is still in effect" : null,
    excerptId: "03-second-amendment.pdf#§3",
    quote,
  });

  // Routes each systemone request by its question names; the nouls map keys
  // by question name and falls back to `fallback`.
  function noulFetch(nouls: Record<string, number>, fallback = 0.9) {
    return vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as {
        questions: Record<string, unknown>;
      };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((name) => [
          name,
          { type: "noul", noul: nouls[name] ?? fallback },
        ]),
      );
      return Promise.resolve(jevResponse(answers));
    });
  }

  describe("crosscheckSchedule", () => {
    it("pass: each release lands in its expected band, with verbatim instructions", async () => {
      const releases = [
        release("release-1", false, "unconditional quote"),
        release("release-ext-1", true, "conditional quote"),
      ];
      const fetchImpl = noulFetch({
        "release_release-1": 0.03,
        "release_release-ext-1": 0.97,
      });
      const out = await provider(fetchImpl).crosscheckSchedule(releases);
      expect(out.status).toBe("pass");
      if (out.status !== "pass") return;
      expect(out.checks.map((c) => c.question)).toEqual([
        "release_release-1",
        "release_release-ext-1",
      ]);
      // Different quotes -> one request per release.
      const reqs = bodies(fetchImpl);
      expect(reqs).toHaveLength(2);
      expect(reqs[0]?.state).toEqual({ quote: "unconditional quote" });
      expect(reqs[0]?.questions["release_release-1"]?.instructions).toBe(
        "The quoted clause makes the payment of $75,000 conditional on an extension or another condition.",
      );
      expect(reqs[1]?.state).toEqual({ quote: "conditional quote" });
    });

    it("releases sharing one quote go in a single request", async () => {
      const releases = [
        release("release-1", false, "shared quote"),
        release("release-2", false, "shared quote"),
      ];
      const fetchImpl = noulFetch({}, 0.03);
      const out = await provider(fetchImpl).crosscheckSchedule(releases);
      expect(out.status).toBe("pass");
      const reqs = bodies(fetchImpl);
      expect(reqs).toHaveLength(1);
      expect(Object.keys(reqs[0]?.questions ?? {})).toEqual([
        "release_release-1",
        "release_release-2",
      ]);
    });

    it("mismatch: a clear opposite answer names the release", async () => {
      const releases = [release("release-1", false, "unconditional quote")];
      const fetchImpl = noulFetch({ "release_release-1": 0.95 });
      const out = await provider(fetchImpl).crosscheckSchedule(releases);
      expect(out.status).toBe("mismatch");
      if (out.status !== "mismatch") return;
      expect(out.detail).toContain("release-1");
      expect(out.checks[0]?.noul).toBe(0.95);
    });

    it("uncertain: the middle band is undecided, not a mismatch", async () => {
      const releases = [release("release-ext-1", true, "conditional quote")];
      const fetchImpl = noulFetch({ "release_release-ext-1": 0.5 });
      const out = await provider(fetchImpl).crosscheckSchedule(releases);
      expect(out.status).toBe("uncertain");
      if (out.status !== "uncertain") return;
      expect(out.detail).toContain("release-ext-1");
      expect(out.checks).toHaveLength(1);
    });

    it("failed: a missing noul answer is a schema mismatch", async () => {
      const releases = [release("release-1", false, "unconditional quote")];
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jevResponse({ "release_release-1": { type: "noul" } }));
      const out = await provider(fetchImpl).crosscheckSchedule(releases);
      expect(out.status).toBe("failed");
      if (out.status !== "failed") return;
      expect(out.reason).toBe("schema_mismatch");
    });
  });

  describe("crosscheckCounter", () => {
    const quote = "We propose that $6,000 of the January 2, 2027 release be paid in two monthly parts, the first on November 2, 2026.";
    const texts = {
      amount_text: "$6,000",
      date_text: "November 2, 2026",
      split_count_text: "two",
    };

    it("pass: noul >= 0.8 with the lever's verbatim instruction", async () => {
      const fetchImpl = noulFetch({ counter_proposal: 0.97 });
      const out = await provider(fetchImpl).crosscheckCounter({
        lever: "milestone_split",
        texts,
        quote,
      });
      expect(out.status).toBe("pass");
      const req = lastBody(fetchImpl);
      expect(req.state).toEqual({ quote });
      expect(req.questions.counter_proposal?.instructions).toBe(
        "The sentence proposes paying $6,000 in two monthly parts, the first on November 2, 2026.",
      );
    });

    it("mismatch: noul <= 0.2", async () => {
      const fetchImpl = noulFetch({ counter_proposal: 0.1 });
      const out = await provider(fetchImpl).crosscheckCounter({
        lever: "earlier_release",
        texts: { amount_text: "$6,000", date_text: "November 2, 2026" },
        quote,
      });
      expect(out.status).toBe("mismatch");
      if (out.status !== "mismatch") return;
      expect(out.checks[0]?.noul).toBe(0.1);
    });

    it("uncertain: between the bands", async () => {
      const fetchImpl = noulFetch({ counter_proposal: 0.5 });
      const out = await provider(fetchImpl).crosscheckCounter({
        lever: "upfront_deposit",
        texts: { amount_text: "$6,000", date_text: "October 1, 2026" },
        quote,
      });
      expect(out.status).toBe("uncertain");
    });

    it("each lever builds its own instruction", async () => {
      const cases: [Parameters<JevDecisionProvider["crosscheckCounter"]>[0], string][] = [
        [
          {
            lever: "upfront_deposit",
            texts: { amount_text: "$3,000", date_text: "October 1, 2026" },
            quote,
          },
          "The sentence proposes paying $3,000 to the consultant as an upfront deposit on October 1, 2026.",
        ],
        [
          {
            lever: "earlier_release",
            texts: { amount_text: "$5,000", date_text: "December 1, 2026" },
            quote,
          },
          "The sentence proposes releasing $5,000 from escrow early, on December 1, 2026.",
        ],
        [
          {
            lever: "milestone_split",
            texts: {
              amount_text: "$6,000",
              split_count_text: "three",
              date_text: "November 2, 2026",
            },
            quote,
          },
          "The sentence proposes paying $6,000 in three monthly parts, the first on November 2, 2026.",
        ],
        [
          {
            lever: "shorter_payment_terms",
            texts: { net_days_text: "30 days" },
            quote,
          },
          "The sentence proposes paying each month's fees 30 days after the month ends.",
        ],
      ];
      for (const [args, expected] of cases) {
        const fetchImpl = noulFetch({}, 0.97);
        const out = await provider(fetchImpl).crosscheckCounter(args);
        expect(out.status).toBe("pass");
        expect(lastBody(fetchImpl).questions.counter_proposal?.instructions).toBe(expected);
      }
    });

    it("missing texts fail without a call", async () => {
      const fetchImpl = noulFetch({});
      const out = await provider(fetchImpl).crosscheckCounter({
        lever: "milestone_split",
        texts: { amount_text: "$6,000" },
        quote,
      });
      expect(out.status).toBe("failed");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("crosscheckPaymentTerms", () => {
    const term = (
      id: string,
      kind: ValidatedTerm["kind"],
      fields: Partial<ValidatedTerm>,
      quote: string,
    ): ValidatedTerm => ({
      id,
      kind,
      amountText: null,
      amountCents: null,
      dateText: null,
      date: null,
      recurrenceText: null,
      recurrence: "one_off",
      netDaysText: null,
      netDays: null,
      excerptId: "e.pdf#§1",
      quote,
      ...fields,
    });

    it("pass: every term lands at or above the band, verbatim instructions per kind", async () => {
      const terms = [
        term("term-1", "fixed_date_payment", {
          amountText: "$5,000.00",
          dateText: "per month",
          recurrenceText: "per month",
        }, "fee quote"),
        term("term-2", "payment_terms", { netDaysText: "net 30 days" }, "terms quote"),
        term("term-3", "deposit", { amountText: "$2,000", dateText: "on signing" }, "deposit quote"),
        term("term-4", "escrow_release", { amountText: "$9,000", dateText: "June 1, 2024" }, "release quote"),
      ];
      const fetchImpl = noulFetch({}, 0.95);
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("pass");
      const reqs = bodies(fetchImpl);
      expect(reqs).toHaveLength(4);
      expect(reqs[0]?.questions["term_term-1"]?.instructions).toBe(
        "The quoted clause sets a cash fee of $5,000.00 per month, paid or invoiced per month.",
      );
      expect(reqs[1]?.questions["term_term-2"]?.instructions).toBe(
        "The quoted clause gives the client net 30 days to pay an invoice.",
      );
      expect(reqs[2]?.questions["term_term-3"]?.instructions).toBe(
        "The quoted clause requires a payment of $2,000 on signing.",
      );
      expect(reqs[3]?.questions["term_term-4"]?.instructions).toBe(
        "The quoted clause releases $9,000 from escrow June 1, 2024.",
      );
    });

    it("a fixed_date_payment without a recurrence reads without it", async () => {
      const terms = [
        term("term-1", "fixed_date_payment", {
          amountText: "$500",
          dateText: "July 1, 2024",
        }, "q"),
      ];
      const fetchImpl = noulFetch({}, 0.9);
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("pass");
      expect(lastBody(fetchImpl).questions["term_term-1"]?.instructions).toBe(
        "The quoted clause sets a cash fee of $500, paid or invoiced July 1, 2024.",
      );
    });

    it("terms sharing one quote go in a single request", async () => {
      const terms = [
        term("term-1", "payment_terms", { netDaysText: "net 30 days" }, "shared"),
        term("term-2", "payment_terms", { netDaysText: "net 30 days" }, "shared"),
      ];
      const fetchImpl = noulFetch({}, 0.9);
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("pass");
      expect(bodies(fetchImpl)).toHaveLength(1);
    });

    it("mismatch: a clear no names the term", async () => {
      const terms = [
        term("term-1", "payment_terms", { netDaysText: "net 30 days" }, "q"),
      ];
      const fetchImpl = noulFetch({ "term_term-1": 0.05 });
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("mismatch");
      if (out.status !== "mismatch") return;
      expect(out.detail).toContain("term-1");
      expect(out.checks[0]?.noul).toBe(0.05);
    });

    it("uncertain: the middle band is undecided", async () => {
      const terms = [
        term("term-1", "payment_terms", { netDaysText: "net 30 days" }, "q"),
      ];
      const fetchImpl = noulFetch({ "term_term-1": 0.5 });
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("uncertain");
    });

    it("failed: a term that cannot fill its instruction is a schema mismatch", async () => {
      const terms = [term("term-1", "payment_terms", { netDaysText: null }, "q")];
      const out = await provider(fetch).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("failed");
      if (out.status !== "failed") return;
      expect(out.reason).toBe("schema_mismatch");
    });

    it("failed: a missing noul answer is a schema mismatch", async () => {
      const terms = [
        term("term-1", "payment_terms", { netDaysText: "net 30 days" }, "q"),
      ];
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jevResponse({ "term_term-1": { type: "noul" } }));
      const out = await provider(fetchImpl).crosscheckPaymentTerms(terms);
      expect(out.status).toBe("failed");
      if (out.status !== "failed") return;
      expect(out.reason).toBe("schema_mismatch");
    });
  });
});


