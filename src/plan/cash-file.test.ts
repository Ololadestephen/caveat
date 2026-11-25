import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseCashFile } from "./cash-file.ts";
import type { TwinveeAssumptions } from "./twinvee.ts";

const DEMO = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../fixtures/plan/twinvee-demo-assumptions.json", import.meta.url)),
    "utf8",
  ),
) as TwinveeAssumptions;

const CSV_V1 = readFileSync(
  fileURLToPath(new URL("../../fixtures/box/my-cash.csv", import.meta.url)),
);
const CSV_V2 = readFileSync(
  fileURLToPath(new URL("../../fixtures/box/my-cash-v2.csv", import.meta.url)),
);

function csv(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const VALID = `kind,date,amount_usd
opening,2026-10-01,20000.00
floor,,10000.00
cost,2026-10-15,6000.00
cost,2026-11-15,6000.00`;

function parse(text: string) {
  return parseCashFile(csv(text), DEMO);
}

describe("parseCashFile", () => {
  it("parses the v1 fixture into numbers identical to the demo assumptions", () => {
    const result = parseCashFile(CSV_V1, DEMO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.assumptions;
    expect({
      startDate: a.startDate,
      openingCents: a.openingCents,
      floorCents: a.floorCents,
      costs: a.costs,
    }).toEqual({
      startDate: DEMO.startDate,
      openingCents: DEMO.openingCents,
      floorCents: DEMO.floorCents,
      costs: DEMO.costs,
    });
    expect(a.escrowFundingDate).toBe(DEMO.escrowFundingDate);
    expect(a.escrowFundingNote).toBe(DEMO.escrowFundingNote);
    expect(a.note).toBe("Owner cash file my-cash.csv");
  });

  it("parses the v2 fixture with the raised opening", () => {
    const result = parseCashFile(CSV_V2, DEMO);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assumptions.openingCents).toBe(2300000);
    expect(result.assumptions.floorCents).toBe(1000000);
  });

  it("accepts CRLF line endings", () => {
    const result = parse(VALID.replaceAll("\n", "\r\n"));
    expect(result.ok).toBe(true);
  });

  it("converts decimal amounts without floats: 0.29 is exactly 29 cents", () => {
    const result = parse(`${VALID}\ncost,2026-12-15,0.29`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assumptions.costs[2]?.amountCents).toBe(29);
  });

  it("rejects comma-grouped amounts like 6,000.00", () => {
    const result = parse(`kind,date,amount_usd
opening,2026-10-01,20000.00
floor,,10000.00
cost,2026-10-15,6,000.00`);
    expect(result).toMatchObject({ ok: false, code: "bad_row", line: 4 });
    // and as a bare amount with no comma grouping it hits bad_amount
    const result2 = parse(`kind,date,amount_usd
opening,2026-10-01,20000.00
floor,,10000.00
cost,2026-10-15,abc`);
    expect(result2).toMatchObject({ ok: false, code: "bad_amount", line: 4 });
  });

  it("rejects a wrong header", () => {
    expect(parse("kind,day,amount_usd\n" + VALID.split("\n").slice(1).join("\n"))).toMatchObject({
      ok: false,
      code: "bad_header",
      line: 1,
    });
  });

  it("rejects a blank line", () => {
    const result = parse(`${VALID}\n`);
    // trailing newline alone is fine
    expect(result.ok).toBe(true);
    const withBlank = parse(`${VALID}\n\n`);
    expect(withBlank).toMatchObject({ ok: false, code: "bad_row" });
  });

  it("rejects an unknown kind", () => {
    expect(parse(`${VALID}\nbonus,2026-10-01,100.00`)).toMatchObject({
      ok: false,
      code: "bad_kind",
      line: 6,
    });
  });

  it("rejects an invalid date and a floor row that carries one", () => {
    expect(parse(`${VALID}\ncost,2026-13-40,6000.00`)).toMatchObject({
      ok: false,
      code: "bad_date",
      line: 6,
    });
    expect(
      parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,2026-10-01,10000.00\ncost,2026-10-15,6000.00`),
    ).toMatchObject({ ok: false, code: "bad_date", line: 3 });
  });

  it("rejects duplicate opening and floor rows", () => {
    expect(parse(`${VALID}\nopening,2026-10-01,1.00`)).toMatchObject({
      ok: false,
      code: "duplicate_opening",
      line: 6,
    });
    expect(parse(`${VALID}\nfloor,,1.00`)).toMatchObject({
      ok: false,
      code: "duplicate_floor",
      line: 6,
    });
  });

  it("rejects a file with no opening, no floor, or no costs", () => {
    expect(parse(`kind,date,amount_usd\nfloor,,10000.00\ncost,2026-10-15,6000.00`)).toMatchObject({
      ok: false,
      code: "missing_opening",
    });
    expect(parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\ncost,2026-10-15,6000.00`)).toMatchObject({
      ok: false,
      code: "missing_floor",
    });
    expect(parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,,10000.00`)).toMatchObject({
      ok: false,
      code: "no_costs",
    });
  });

  it("rejects more than 60 cost rows", () => {
    const costs = Array.from({ length: 61 }, (_, i) => `cost,2026-10-15,${i + 1}.00`).join("\n");
    expect(
      parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,,10000.00\n${costs}`),
    ).toMatchObject({ ok: false, code: "too_many_costs" });
  });

  it("rejects costs before the opening date or beyond 24 months", () => {
    expect(
      parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,,10000.00\ncost,2026-09-15,6000.00`),
    ).toMatchObject({ ok: false, code: "cost_out_of_range", line: 4 });
    expect(
      parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,,10000.00\ncost,2028-10-02,6000.00`),
    ).toMatchObject({ ok: false, code: "cost_out_of_range", line: 4 });
    // exactly 24 months later is allowed
    expect(
      parse(`kind,date,amount_usd\nopening,2026-10-01,20000.00\nfloor,,10000.00\ncost,2028-10-01,6000.00`),
    ).toMatchObject({ ok: true });
  });

  it("rejects an opening after the escrow funding date", () => {
    expect(
      parse(`kind,date,amount_usd\nopening,2026-11-01,20000.00\nfloor,,10000.00\ncost,2026-11-15,6000.00`),
    ).toMatchObject({ ok: false, code: "opening_after_funding", line: 2 });
  });

  it("rejects files over 16 KiB", () => {
    const big = new Uint8Array(16 * 1024 + 1).fill(32);
    expect(parseCashFile(big, DEMO)).toMatchObject({ ok: false, code: "too_large", line: 0 });
  });

  it("numbers later same-month costs -2, -3 in file order and sorts by date", () => {
    const result = parse(`kind,date,amount_usd
opening,2026-10-01,20000.00
floor,,10000.00
cost,2026-11-20,100.00
cost,2026-10-20,200.00
cost,2026-11-10,300.00
cost,2026-10-10,400.00`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assumptions.costs).toEqual([
      { id: "cost-2026-10-2", date: "2026-10-10", amountCents: 40000 },
      { id: "cost-2026-10", date: "2026-10-20", amountCents: 20000 },
      { id: "cost-2026-11-2", date: "2026-11-10", amountCents: 30000 },
      { id: "cost-2026-11", date: "2026-11-20", amountCents: 10000 },
    ]);
  });
});
