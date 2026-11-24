import { describe, expect, it } from "vitest";
import { buildDecisionUserPrompt, excerptTags } from "./prompt.ts";
import type { Excerpt, Question } from "./types.ts";

const EXCERPT: Excerpt = {
  id: "file.pdf#§1.3",
  text: "the clause text",
  source: {
    fileName: "file.pdf",
    versionLabel: "sha256 abc123def456",
    page: 2,
    section: "§1.3",
  },
};

describe("excerptTags", () => {
  it("wraps each excerpt with id, file, version, page and section", () => {
    expect(excerptTags([EXCERPT])).toBe(
      '<excerpt id="file.pdf#§1.3" file="file.pdf" version="sha256 abc123def456" page="2" section="§1.3">\nthe clause text\n</excerpt>',
    );
  });

  it("omits the section attribute when absent", () => {
    const e: Excerpt = {
      ...EXCERPT,
      source: { fileName: "file.pdf", versionLabel: "sha256 abc123def456", page: 2 },
    };
    expect(excerptTags([e])).not.toContain("section=");
  });
});

describe("buildDecisionUserPrompt", () => {
  it("leads with the question line then the excerpts", () => {
    const question: Question = {
      spec: { id: "q", questionText: "does X apply?", actions: ["a", "b"] },
      id: "q",
      excerpts: [EXCERPT],
    };
    const prompt = buildDecisionUserPrompt(question);
    expect(prompt.startsWith("Question q: does X apply?\n\n<excerpt ")).toBe(true);
  });
});
