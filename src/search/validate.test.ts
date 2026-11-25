import { describe, expect, it } from "vitest";

import { validateProposal } from "./validate.ts";

function payload(candidates: unknown[], done: boolean): unknown {
  return { round_note: "note", done, candidates };
}

const DEPOSIT = {
  lever: "upfront_deposit",
  amount_cents: 800000,
  date: "2026-10-01",
  split_count: null,
  net_days: null,
  rationale: "deposit",
};
const RELEASE = {
  lever: "earlier_release",
  amount_cents: 800000,
  date: "2026-11-13",
  split_count: null,
  net_days: null,
  rationale: "release",
};

describe("validateProposal", () => {
  it("rejects done=false with fewer than 2 candidates", () => {
    expect(validateProposal(payload([DEPOSIT], false)).ok).toBe(false);
    expect(validateProposal(payload([], false)).ok).toBe(false);
    const out = validateProposal(payload([DEPOSIT], false));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain("fewer than 2 candidates");
  });

  it("rejects two candidates on the same lever", () => {
    const out = validateProposal(payload([DEPOSIT, { ...DEPOSIT, amount_cents: 700000 }], false));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain("repeats");
  });

  it("rejects a repeated lever even when done is true", () => {
    expect(validateProposal(payload([DEPOSIT, DEPOSIT], true)).ok).toBe(false);
  });

  it("accepts done=true with zero candidates and done=false with 2-3 distinct levers", () => {
    expect(validateProposal(payload([], true)).ok).toBe(true);
    expect(validateProposal(payload([DEPOSIT, RELEASE], false)).ok).toBe(true);
    const split = {
      lever: "milestone_split",
      amount_cents: 6000000,
      date: "2026-11-02",
      split_count: 2,
      net_days: null,
      rationale: "split",
    };
    expect(validateProposal(payload([DEPOSIT, RELEASE, split], false)).ok).toBe(true);
  });

  it("still rejects more than 3 candidates and malformed items", () => {
    expect(validateProposal(payload([DEPOSIT, RELEASE, DEPOSIT, RELEASE], true)).ok).toBe(false);
    expect(validateProposal(payload([{ nope: true }, RELEASE], false)).ok).toBe(false);
  });
});
