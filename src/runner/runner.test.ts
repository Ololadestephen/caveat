import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture } from "./run.ts";
import type { ScenarioResult } from "./types.ts";

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const SYNTHETIC = loadJson("../../fixtures/runner/synthetic-12k.json");
const SYNTHETIC_EXPECTED = loadJson("../../fixtures/runner/synthetic-12k.expected.json") as {
  results: Record<string, Record<string, ScenarioResult>>;
  smallestPassingCandidate: string | null;
};
const TWINVEE = loadJson("../../fixtures/runner/twinvee-escrow.json");
const TWINVEE_EXPECTED = loadJson("../../fixtures/runner/twinvee-escrow.expected.json") as {
  results: Record<string, Record<string, ScenarioResult>>;
  smallestPassingCandidate: string | null;
};

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startDate: "2027-01-04",
    openingCents: 100000,
    floorCents: 50000,
    costs: [],
    candidates: [{ id: "c1", rankCents: 0, totalCents: 0, paymentRules: [] }],
    scenarios: [{ id: "base" }],
    passingScenarios: ["base"],
    ...overrides,
  };
}

function onlyResult(out: ReturnType<typeof runFixture>): ScenarioResult {
  return Object.values(Object.values(out.results)[0] ?? {})[0] as ScenarioResult;
}

describe("fixture deep-equality", () => {
  it("reproduces the synthetic-12k expected results exactly", () => {
    const out = runFixture(SYNTHETIC);
    expect(out.results).toEqual(SYNTHETIC_EXPECTED.results);
    expect(out.smallestPassingCandidate).toBe(SYNTHETIC_EXPECTED.smallestPassingCandidate);
  });

  it("reproduces the twinvee-escrow expected results exactly", () => {
    const out = runFixture(TWINVEE);
    expect(out.results).toEqual(TWINVEE_EXPECTED.results);
    expect(out.smallestPassingCandidate).toBe(TWINVEE_EXPECTED.smallestPassingCandidate);
  });
});

describe("hand-check headline numbers", () => {
  const out = runFixture(SYNTHETIC);
  const twinvee = runFixture(TWINVEE);

  it("synthetic: quote with no deposit breaches week 4 and bottoms at $160", () => {
    const r = out.results.quote_no_deposit?.acceptance_delay_21d;
    expect(r?.passes).toBe(false);
    expect(r?.firstBreach).toEqual({ date: "2027-01-29", week: 4, balanceCents: 180000 });
    expect(r?.lowest).toEqual({ date: "2027-02-12", balanceCents: 16000 });
    expect(r?.endBalanceCents).toBe(1216000);
  });

  it("synthetic: $1,000 deposit fails; $2,000 deposit passes and is the smallest", () => {
    const d1000 = out.results.deposit_1000?.acceptance_delay_21d;
    expect(d1000?.passes).toBe(false);
    expect(d1000?.firstBreach).toEqual({ date: "2027-02-12", week: 6, balanceCents: 116000 });
    const d2000 = out.results.deposit_2000?.acceptance_delay_21d;
    expect(d2000?.passes).toBe(true);
    expect(d2000?.lowest).toEqual({ date: "2027-02-12", balanceCents: 216000 });
    expect(out.smallestPassingCandidate).toBe("deposit_2000");
  });

  it("twinvee: breaches with $150k still in escrow; release rolls to Monday", () => {
    const r = twinvee.results.as_signed?.all_extensions;
    expect(r?.firstBreach).toEqual({ date: "2026-11-15", week: 7, balanceCents: 800000 });
    const breachEntry = r?.ledger.find((e) => e.date === "2026-11-15");
    expect(breachEntry?.escrowBalanceCents).toBe(15000000);
    expect(r?.lowest).toEqual({ date: "2026-12-15", balanceCents: 200000 });
    const release = r?.ledger.find((e) => e.id === "release-1");
    expect(release?.date).toBe("2027-01-04");
    expect(twinvee.smallestPassingCandidate).toBeNull();
  });
});

describe("on_acceptance delay separation", () => {
  const candidate = {
    id: "c1",
    rankCents: 0,
    totalCents: 100000,
    paymentRules: [
      {
        id: "pay",
        kind: "on_acceptance",
        amountCents: 100000,
        deliveryDate: "2027-01-04",
        acceptanceWindowDays: 0,
        netDays: 0,
      },
    ],
  };

  function receivedDate(scenario: Record<string, unknown>): string {
    const out = runFixture(
      input({ candidates: [candidate], scenarios: [{ id: "base", ...scenario }] }),
    );
    return onlyResult(out).ledger[0]?.date as string;
  }

  it("each delay moves only its own component", () => {
    expect(receivedDate({})).toBe("2027-01-04");
    expect(receivedDate({ acceptanceDelayDays: 2 })).toBe("2027-01-06");
    expect(receivedDate({ paymentLagDays: 3 })).toBe("2027-01-07");
    // 01-06 due + 3 lag lands on Saturday 01-09, received Monday 01-11.
    expect(receivedDate({ acceptanceDelayDays: 2, paymentLagDays: 3 })).toBe("2027-01-11");
  });

  it("the acceptance window moves the due date the same way", () => {
    const wider = {
      ...candidate,
      paymentRules: [{ ...candidate.paymentRules[0], acceptanceWindowDays: 2 }],
    };
    const out = runFixture(input({ candidates: [wider] }));
    expect(onlyResult(out).ledger[0]?.date).toBe("2027-01-06");
  });
});

describe("weekend roll", () => {
  function payOn(date: string): ScenarioResult {
    const out = runFixture(
      input({
        candidates: [
          {
            id: "c1",
            rankCents: 0,
            totalCents: 700,
            paymentRules: [{ id: "pay", kind: "on_date", amountCents: 700, date }],
          },
        ],
      }),
    );
    return onlyResult(out);
  }

  it("rolls Saturday and Sunday receipts to Monday, leaves Friday alone", () => {
    expect(payOn("2027-01-09").ledger[0]?.date).toBe("2027-01-11"); // Sat -> Mon
    expect(payOn("2027-01-10").ledger[0]?.date).toBe("2027-01-11"); // Sun -> Mon
    expect(payOn("2027-01-08").ledger[0]?.date).toBe("2027-01-08"); // Fri unchanged
  });

  it("never rolls costs", () => {
    const out = runFixture(
      input({ costs: [{ id: "rent", date: "2027-01-09", amountCents: 100 }] }),
    );
    expect(onlyResult(out).ledger[0]?.date).toBe("2027-01-09");
    expect(onlyResult(out).ledger[0]?.kind).toBe("cost");
  });
});

describe("same-day ordering and the floor", () => {
  it("posts outflows before inflows so an inflow-first run cannot hide a breach", () => {
    const out = runFixture(
      input({
        openingCents: 1000,
        floorCents: 500,
        costs: [{ id: "cost", date: "2027-01-05", amountCents: 800 }],
        candidates: [
          {
            id: "c1",
            rankCents: 0,
            totalCents: 1000,
            paymentRules: [{ id: "pay", kind: "on_date", amountCents: 1000, date: "2027-01-05" }],
          },
        ],
      }),
    );
    const r = onlyResult(out);
    expect(r.passes).toBe(false);
    expect(r.firstBreach).toEqual({ date: "2027-01-05", week: 1, balanceCents: 200 });
    expect(r.ledger.map((e) => e.kind)).toEqual(["cost", "payment"]);
  });

  it("orders same-kind same-day events by id ascending", () => {
    const out = runFixture(
      input({
        costs: [
          { id: "b-cost", date: "2027-01-05", amountCents: 10 },
          { id: "a-cost", date: "2027-01-05", amountCents: 10 },
        ],
      }),
    );
    expect(onlyResult(out).ledger.map((e) => e.id)).toEqual(["a-cost", "b-cost"]);
  });

  it("does not breach when the balance lands exactly on the floor", () => {
    const out = runFixture(
      input({
        openingCents: 1000,
        floorCents: 500,
        costs: [{ id: "cost", date: "2027-01-05", amountCents: 500 }],
      }),
    );
    const r = onlyResult(out);
    expect(r.passes).toBe(true);
    expect(r.firstBreach).toBeNull();
    expect(r.ledger[0]?.balanceCents).toBe(500);
  });

  it("matches the fixture floor-equality case (deposit_1000 on 2027-02-05)", () => {
    const r = runFixture(SYNTHETIC).results.deposit_1000?.acceptance_delay_21d;
    const atFloor = r?.ledger.find((e) => e.date === "2027-02-05");
    expect(atFloor?.balanceCents).toBe(200000);
    expect(r?.firstBreach?.date).toBe("2027-02-12");
  });
});

describe("escrow and extensions", () => {
  it("an escrow deposit never changes the cash balance", () => {
    const out = runFixture(
      input({
        candidates: [
          {
            id: "c1",
            rankCents: 0,
            totalCents: 5000,
            paymentRules: [
              { id: "dep", kind: "escrow_deposit", amountCents: 5000, date: "2027-01-05" },
              { id: "rel", kind: "escrow_release", amountCents: 5000, date: "2027-01-06" },
            ],
          },
        ],
      }),
    );
    const r = onlyResult(out);
    const deposit = r.ledger.find((e) => e.id === "dep");
    expect(deposit?.cashDeltaCents).toBe(0);
    expect(deposit?.balanceCents).toBe(100000);
    expect(deposit?.escrowBalanceCents).toBe(5000);
    expect(r.endEscrowCents).toBe(0);
    expect(r.endBalanceCents).toBe(105000);
  });

  it("skips conditional releases unless the extension is granted", () => {
    const candidate = {
      id: "c1",
      rankCents: 0,
      totalCents: 5000,
      paymentRules: [
        { id: "dep", kind: "escrow_deposit", amountCents: 5000, date: "2027-01-05" },
        {
          id: "rel",
          kind: "escrow_release",
          amountCents: 5000,
          date: "2027-01-06",
          requiresExtension: "ext-1",
        },
      ],
    };
    const denied = runFixture(
      input({ candidates: [candidate], scenarios: [{ id: "base" }] }),
    );
    const granted = runFixture(
      input({
        candidates: [candidate],
        scenarios: [{ id: "base", extensionsGranted: ["ext-1"] }],
      }),
    );
    expect(onlyResult(denied).ledger.find((e) => e.id === "rel")).toBeUndefined();
    expect(onlyResult(denied).endEscrowCents).toBe(5000);
    expect(onlyResult(granted).ledger.find((e) => e.id === "rel")).toBeDefined();
    expect(onlyResult(granted).endEscrowCents).toBe(0);
  });
});

describe("smallestPassingCandidate", () => {
  it("is null when no candidate passes every scenario", () => {
    const out = runFixture(
      input({
        floorCents: 5000,
        openingCents: 0,
        costs: [{ id: "cost", date: "2027-01-05", amountCents: 6000 }],
        candidates: [
          { id: "a", rankCents: 0, totalCents: 0, paymentRules: [] },
          { id: "b", rankCents: 100, totalCents: 0, paymentRules: [] },
        ],
      }),
    );
    expect(out.smallestPassingCandidate).toBeNull();
  });

  it("picks the passing candidate with the smallest rankCents", () => {
    const mk = (id: string, rank: number) => ({ id, rankCents: rank, totalCents: 0, paymentRules: [] });
    const out = runFixture(input({ candidates: [mk("big", 900), mk("small", 100), mk("mid", 500)] }));
    expect(out.smallestPassingCandidate).toBe("small");
  });
});

describe("determinism and digests", () => {
  it("produces identical digests for identical input", () => {
    const a = runFixture(SYNTHETIC);
    const b = runFixture(JSON.parse(JSON.stringify(SYNTHETIC)));
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.resultDigest).toBe(b.resultDigest);
    expect(a.runnerVersion).toBe(b.runnerVersion);
  });

  it("input digest is independent of key order", () => {
    const reordered = {
      passingScenarios: (SYNTHETIC as Record<string, unknown>).passingScenarios,
      scenarios: (SYNTHETIC as Record<string, unknown>).scenarios,
      candidates: (SYNTHETIC as Record<string, unknown>).candidates,
      costs: (SYNTHETIC as Record<string, unknown>).costs,
      floorCents: (SYNTHETIC as Record<string, unknown>).floorCents,
      openingCents: (SYNTHETIC as Record<string, unknown>).openingCents,
      startDate: (SYNTHETIC as Record<string, unknown>).startDate,
      description: (SYNTHETIC as Record<string, unknown>).description,
      label: (SYNTHETIC as Record<string, unknown>).label,
    };
    expect(runFixture(reordered).inputDigest).toBe(runFixture(SYNTHETIC).inputDigest);
  });

  it("both digests change when one cent changes", () => {
    const base = runFixture(SYNTHETIC);
    const mutated = JSON.parse(JSON.stringify(SYNTHETIC)) as {
      costs: { amountCents: number }[];
    };
    const first = mutated.costs[0];
    if (first) first.amountCents += 1;
    const changed = runFixture(mutated);
    expect(changed.inputDigest).not.toBe(base.inputDigest);
    expect(changed.resultDigest).not.toBe(base.resultDigest);
  });
});
