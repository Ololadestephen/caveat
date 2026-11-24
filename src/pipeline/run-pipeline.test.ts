import { describe, expect, it } from "vitest";

import { runPipeline } from "./run-pipeline.ts";

const config = {
  runId: "run-test",
  reviewsDir: "reviews",
  fixturesDir: "fixtures",
};

describe("runPipeline connector checks", () => {
  it("fails fast when the box connector is missing", async () => {
    await expect(runPipeline({ ...config, connections: [] })).rejects.toThrow(
      "box connector not configured",
    );
  });

  it("fails fast when the openrouter connector is missing", async () => {
    await expect(
      runPipeline({
        ...config,
        connections: [{ provider: "box", gatewayBaseUrl: "http://127.0.0.1:1" }],
      }),
    ).rejects.toThrow("openrouter connector not configured");
  });

  it("tags failures with the failing step", async () => {
    const error = await runPipeline({ ...config, connections: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { step?: string }).step).toBe("box");
  });
});
