import { describe, expect, it } from "vitest";

import { isRecord, keySetError } from "./shape.ts";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null and primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("keySetError", () => {
  it("returns undefined when the key set matches exactly", () => {
    expect(keySetError({ a: 1, b: 2 }, ["a", "b"])).toBeUndefined();
  });

  it("reports missing keys", () => {
    expect(keySetError({ a: 1 }, ["a", "b"])).toBe("missing keys: b");
  });

  it("reports unexpected keys", () => {
    expect(keySetError({ a: 1, b: 2 }, ["a"])).toBe("unexpected keys: b");
  });

  it("reports both, missing first", () => {
    expect(keySetError({ b: 2, c: 3 }, ["a", "b"])).toBe(
      "missing keys: a; unexpected keys: c",
    );
  });
});
