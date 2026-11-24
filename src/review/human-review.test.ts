import { describe, expect, it } from "vitest";
import { validateRetainerReview, validateSourcedOverride } from "./human-review.ts";

const SECTIONS = [
  {
    fileName: "01-consulting-agreement.pdf",
    sectionId: "§1.3",
    text: "1.3 Company shall compensate Consultant at a rate of $6,000 per month for work related to the Services.",
  },
  {
    fileName: "01-consulting-agreement.pdf",
    sectionId: "§1.4",
    text: "1.4 Fees shall be paid via his limited liability company on the 1st of each month.",
  },
  {
    fileName: "01-consulting-agreement.pdf",
    sectionId: "§1.5",
    text: "1.5 The term of this Agreement shall commence as of April 1, 2026 and expire on December 31, 2026, unless earlier terminated.",
  },
  {
    fileName: "03-second-amendment.pdf",
    sectionId: "§3(a)",
    text: "The Company shall pay Consultant $25,000 per month.",
  },
  {
    fileName: "03-second-amendment.pdf",
    sectionId: "§4",
    text: "Except as expressly amended, all terms of the Consulting Agreement remain unchanged and in full force and effect. In the event of any conflict, this Amendment shall control.",
  },
  {
    fileName: "03-second-amendment.pdf",
    sectionId: "§1",
    title: "Recitals",
    text: "1. Recitals WHEREAS, in connection with the proposed Agreement and Plan of Merger and the transactions contemplated thereby, the parties wish to amend.",
  },
];

function validReview(): Record<string, unknown> {
  return {
    questionId: "retainer_after_second_amendment",
    reviewer: "Ololade Stephen",
    reviewedAt: "2026-11-24",
      revision: 2,
      revisionNote: "Corrects revision 1.",
    baseRetainer: {
      answer: "unresolved_compare_both",
      note: "Reviewer chose not to resolve; show both readings side by side.",
      citations: [
        {
          fileName: "03-second-amendment.pdf",
          section: "§4",
          quote:
            "all terms of the Consulting Agreement remain unchanged and in full force and effect",
        },
      ],
      continuesReading: {
        amount: {
          text: "$6,000 per month",
          fileName: "01-consulting-agreement.pdf",
          section: "§1.3",
          quote: "a rate of $6,000 per month for work related to the Services",
        },
        payDay: {
          text: "on the 1st of each month",
          fileName: "01-consulting-agreement.pdf",
          section: "§1.4",
          quote: "on the 1st of each month",
        },
        termEnd: {
          text: "December 31, 2026",
          fileName: "01-consulting-agreement.pdf",
          section: "§1.5",
          quote: "expire on December 31, 2026, unless earlier terminated",
        },
      },
    },
    firstAmendmentPay: {
      answer: "continues",
      cashEffectInWindow: "none",
      citations: [
        {
          fileName: "03-second-amendment.pdf",
          section: "§4",
          quote: "In the event of any conflict, this Amendment shall control.",
        },
      ],
    },
  };
}

describe("validateRetainerReview", () => {
  it("accepts a fully sourced review", () => {
    const result = validateRetainerReview(validReview(), SECTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseRetainer.answer).toBe("unresolved_compare_both");
      expect(result.value.baseRetainer.continuesReading?.termEnd.text).toBe("December 31, 2026");
    }
  });

  it("rejects a citation whose quote is not verbatim in the section", () => {
    const bad = validReview();
    (bad.baseRetainer as { citations: { quote: string }[] }).citations[0]!.quote =
      "terms may change at any time";
    const result = validateRetainerReview(bad, SECTIONS);
    expect(result).toMatchObject({ ok: false, reason: "review_citation_invalid" });
  });

  it("rejects a citation for a section that was never extracted", () => {
    const bad = validReview();
    (bad.baseRetainer as { citations: { section: string }[] }).citations[0]!.section = "§9";
    const result = validateRetainerReview(bad, SECTIONS);
    expect(result).toMatchObject({ ok: false, reason: "review_citation_invalid" });
  });

  it("rejects a continuesReading text not verbatim inside its quote", () => {
    const bad = validReview();
    const reading = (bad.baseRetainer as { continuesReading: { amount: { text: string } } })
      .continuesReading;
    reading.amount.text = "$9,999 per month";
    const result = validateRetainerReview(bad, SECTIONS);
    expect(result).toMatchObject({ ok: false, reason: "review_citation_invalid" });
  });

  it("rejects a malformed record", () => {
    expect(validateRetainerReview({}, SECTIONS)).toMatchObject({
      ok: false,
      reason: "review_citation_invalid",
    });
    expect(validateRetainerReview("x", SECTIONS)).toMatchObject({
      ok: false,
      reason: "review_citation_invalid",
    });
    const noCites = validReview();
    delete (noCites.firstAmendmentPay as Record<string, unknown>).citations;
    expect(validateRetainerReview(noCites, SECTIONS)).toMatchObject({
      ok: false,
      reason: "review_citation_invalid",
    });
  });

  it("resolves a Recitals citation by section title", () => {
    const review = validReview();
    const pay = review.firstAmendmentPay as { citations: unknown[] };
    pay.citations.push({
      fileName: "03-second-amendment.pdf",
      section: "Recitals",
      quote: "in connection with the proposed Agreement and Plan of Merger and the transactions contemplated thereby",
    });
    const result = validateRetainerReview(review, SECTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.revision).toBe(2);
  });

  it("accepts whitespace-normalised citation quotes", () => {
    const spaced = validReview();
    (spaced.baseRetainer as { citations: { quote: string }[] }).citations[0]!.quote =
      "all terms of the Consulting Agreement\n  remain unchanged and in full force   and effect";
    expect(validateRetainerReview(spaced, SECTIONS).ok).toBe(true);
  });
});

describe("validateSourcedOverride", () => {
  it("accepts a sourced override and rejects unsourced ones", () => {
    const ok = {
      questionId: "release_timing",
      answer: "escrow_release",
      reviewer: "Ololade Stephen",
      reviewedAt: "2026-11-24",
      citations: [
        {
          fileName: "03-second-amendment.pdf",
          section: "§3(a)",
          quote: "The Company shall pay Consultant $25,000 per month.",
        },
      ],
    };
    expect(validateSourcedOverride(ok, SECTIONS).ok).toBe(true);

    const badQuote = JSON.parse(JSON.stringify(ok)) as typeof ok;
    badQuote.citations[0]!.quote = "not in the section";
    expect(validateSourcedOverride(badQuote, SECTIONS)).toMatchObject({
      ok: false,
      reason: "review_citation_invalid",
    });

    const noCites = JSON.parse(JSON.stringify(ok)) as Record<string, unknown>;
    delete noCites.citations;
    expect(validateSourcedOverride(noCites, SECTIONS).ok).toBe(false);
  });
});
