import { describe, expect, it } from "vitest";
import { startTaskHold } from "./task-hold.ts";

describe("startTaskHold", () => {
  it("returns a stoppable hold without throwing where no sprite socket exists", () => {
    const hold = startTaskHold("test-hold");
    expect(typeof hold.stop).toBe("function");
    expect(() => hold.stop()).not.toThrow();
  });
});
