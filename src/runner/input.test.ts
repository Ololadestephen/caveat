import { describe, expect, it } from "vitest";
import { runFixture } from "./run.ts";
import { RunInputError, validateRunInput } from "./validate.ts";

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

function errorPath(raw: unknown): string {
  try {
    validateRunInput(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(RunInputError);
    return (err as RunInputError).path;
  }
  throw new Error("expected RunInputError");
}

describe("validateRunInput", () => {
  it("returns a normalized input with scenario defaults applied", () => {
    const validated = validateRunInput(input());
    expect(validated.scenarios[0]).toEqual({
      id: "base",
      acceptanceDelayDays: 0,
      paymentLagDays: 0,
      extraCosts: [],
      extensionsGranted: [],
    });
    expect(validated.openingCents).toBe(100000);
  });

  it("rejects non-object input", () => {
    expect(() => validateRunInput(null)).toThrow(RunInputError);
    expect(() => validateRunInput([])).toThrow(RunInputError);
    expect(() => validateRunInput("x")).toThrow(RunInputError);
    expect(() => validateRunInput(42)).toThrow(RunInputError);
  });

  it("rejects non-integer, negative and non-number cents", () => {
    for (const bad of [100.5, -5, "100", Number.NaN]) {
      expect(errorPath(input({ openingCents: bad }))).toBe("openingCents");
      expect(
        errorPath(input({ costs: [{ id: "c", date: "2027-01-05", amountCents: bad }] })),
      ).toBe("costs[0].amountCents");
    }
  });

  it("rejects invalid and malformed dates", () => {
    for (const bad of ["2026-02-30", "2027-13-01", "01/05/2027", "2027-1-5"]) {
      expect(errorPath(input({ startDate: bad }))).toBe("startDate");
      expect(
        errorPath(input({ costs: [{ id: "c", date: bad, amountCents: 1 }] })),
      ).toBe("costs[0].date");
    }
  });

  it("rejects missing required fields", () => {
    expect(errorPath({ ...input(), startDate: undefined })).toBe("startDate");
    expect(errorPath(input({ costs: [{ id: "c", amountCents: 1 }] }))).toBe("costs[0].date");
    expect(
      errorPath(input({ candidates: [{ id: "c1", rankCents: 0, totalCents: 0 }] })),
    ).toBe("candidates[0].paymentRules");
  });

  it("rejects unknown fields, catching typos", () => {
    expect(errorPath(input({ floor: 50000 }))).toBe("floor");
    expect(
      errorPath(
        input({
          candidates: [
            {
              id: "c1",
              rankCents: 0,
              totalCents: 100,
              paymentRules: [
                {
                  id: "r",
                  kind: "escrow_deposit",
                  amountCents: 100,
                  date: "2027-01-05",
                  depost: true,
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("candidates[0].paymentRules[0].depost");
  });

  it("rejects duplicate ids across costs, rules and extra costs", () => {
    expect(
      errorPath(
        input({
          costs: [
            { id: "dup", date: "2027-01-05", amountCents: 1 },
            { id: "dup", date: "2027-01-06", amountCents: 1 },
          ],
        }),
      ),
    ).toBe("costs[1].id");

    const ruleCollision = input({
      costs: [{ id: "shared", date: "2027-01-05", amountCents: 1 }],
      candidates: [
        {
          id: "c1",
          rankCents: 0,
          totalCents: 100,
          paymentRules: [{ id: "shared", kind: "on_date", amountCents: 100, date: "2027-01-06" }],
        },
      ],
    });
    expect(errorPath(ruleCollision)).toBe("candidates");

    const extraCollision = input({
      costs: [{ id: "shared", date: "2027-01-05", amountCents: 1 }],
      scenarios: [
        { id: "base", extraCosts: [{ id: "shared", date: "2027-01-06", amountCents: 1 }] },
      ],
    });
    expect(errorPath(extraCollision)).toBe("scenarios.base.extraCosts");
  });

  it("rejects duplicate candidate and scenario ids", () => {
    expect(
      errorPath(
        input({
          candidates: [
            { id: "c1", rankCents: 0, totalCents: 0, paymentRules: [] },
            { id: "c1", rankCents: 1, totalCents: 0, paymentRules: [] },
          ],
        }),
      ),
    ).toBe("candidates");
    expect(
      errorPath(input({ scenarios: [{ id: "base" }, { id: "base" }] })),
    ).toBe("scenarios");
  });

  it("enforces the totalCents invariant per candidate", () => {
    expect(
      errorPath(
        input({
          candidates: [
            {
              id: "c1",
              rankCents: 0,
              totalCents: 200,
              paymentRules: [
                { id: "p", kind: "on_date", amountCents: 100, date: "2027-01-05" },
              ],
            },
          ],
        }),
      ),
    ).toBe("candidates[0].totalCents");
  });

  it("enforces release sum == deposit sum", () => {
    expect(
      errorPath(
        input({
          candidates: [
            {
              id: "c1",
              rankCents: 0,
              totalCents: 5000,
              paymentRules: [
                { id: "dep", kind: "escrow_deposit", amountCents: 5000, date: "2027-01-05" },
                { id: "rel", kind: "escrow_release", amountCents: 4000, date: "2027-01-06" },
              ],
            },
          ],
        }),
      ),
    ).toBe("candidates[0].paymentRules");
  });

  it("rejects releases dated before the first deposit", () => {
    expect(
      errorPath(
        input({
          candidates: [
            {
              id: "c1",
              rankCents: 0,
              totalCents: 5000,
              paymentRules: [
                { id: "dep", kind: "escrow_deposit", amountCents: 5000, date: "2027-01-10" },
                { id: "rel", kind: "escrow_release", amountCents: 5000, date: "2027-01-09" },
              ],
            },
          ],
        }),
      ),
    ).toBe("candidates[0].paymentRules");
  });

  it("rejects unknown rule kinds and unknown passingScenarios", () => {
    expect(
      errorPath(
        input({
          candidates: [
            {
              id: "c1",
              rankCents: 0,
              totalCents: 100,
              paymentRules: [{ id: "p", kind: "on_delivery", amountCents: 100, date: "2027-01-05" }],
            },
          ],
        }),
      ),
    ).toBe("candidates[0].paymentRules[0].kind");
    expect(errorPath(input({ passingScenarios: ["nope"] }))).toBe("passingScenarios[0]");
  });

  it("rejects assumption fields set both at top level and under demoAssumptions", () => {
    expect(
      errorPath(
        input({
          demoAssumptions: { openingCents: 100000, floorCents: 50000, costs: [] },
        }),
      ),
    ).toBe("openingCents");
  });

  it("reads assumptions from demoAssumptions when present", () => {
    const validated = validateRunInput(
      input({
        openingCents: undefined,
        floorCents: undefined,
        costs: undefined,
        demoAssumptions: {
          note: "Demo assumptions, not facts about the parties",
          openingCents: 777,
          floorCents: 100,
          costs: [{ id: "k", date: "2027-01-05", amountCents: 5 }],
        },
      }),
    );
    expect(validated.openingCents).toBe(777);
    expect(validated.costs[0]?.id).toBe("k");
  });
});

describe("runFixture input boundary", () => {
  it("throws RunInputError for invalid input instead of running", () => {
    expect(() => runFixture(input({ floorCents: -1 }))).toThrow(RunInputError);
  });
});
