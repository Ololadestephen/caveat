import { describe, expect, it, vi } from "vitest";

import {
  JEV_MODEL,
  JevDecisionProvider,
  buildReleaseTimingDigestInput,
} from "./jev.ts";
import { digestValue } from "../runner/digest.ts";
import { RELEASE_TIMING } from "./types.ts";
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
