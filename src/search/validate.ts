import { isRecord } from "../shape.ts";
import type { ProposedCandidate, Lever } from "./levers.ts";

export type Proposal = {
  roundNote: string;
  done: boolean;
  candidates: ProposedCandidate[];
};

const LEVERS: readonly string[] = [
  "upfront_deposit",
  "earlier_release",
  "milestone_split",
  "shorter_payment_terms",
];

const NULLABLE_INT = (v: unknown): boolean => v === null || Number.isInteger(v);
const NULLABLE_STRING = (v: unknown): boolean => v === null || typeof v === "string";

// Top-level schema check on the parsed chat payload. Anything not matching the
// contract is a needs_review stop, not a per-candidate rejection.
export function validateProposal(
  parsed: unknown,
): { ok: true; proposal: Proposal } | { ok: false; detail: string } {
  if (!isRecord(parsed)) {
    return { ok: false, detail: "proposal payload is not an object" };
  }
  if (typeof parsed.round_note !== "string" || parsed.round_note.length === 0 || parsed.round_note.length > 400) {
    return { ok: false, detail: "round_note is missing or too long" };
  }
  if (typeof parsed.done !== "boolean") {
    return { ok: false, detail: "done is missing or not a boolean" };
  }
  if (!Array.isArray(parsed.candidates)) {
    return { ok: false, detail: "candidates is missing or not an array" };
  }
  if (parsed.candidates.length > 3) {
    return { ok: false, detail: "more than 3 candidates proposed" };
  }
  if (parsed.done === false && parsed.candidates.length < 2) {
    return { ok: false, detail: "done is false but fewer than 2 candidates were proposed" };
  }
  const candidates: ProposedCandidate[] = [];
  const leversSeen = new Set<string>();
  for (const [i, item] of parsed.candidates.entries()) {
    if (!isRecord(item)) {
      return { ok: false, detail: `candidates[${i}] is not an object` };
    }
    if (typeof item.lever !== "string" || !LEVERS.includes(item.lever)) {
      return { ok: false, detail: `candidates[${i}].lever is not a known lever` };
    }
    if (leversSeen.has(item.lever)) {
      return { ok: false, detail: `candidates[${i}].lever ${item.lever} repeats an earlier candidate's lever` };
    }
    leversSeen.add(item.lever);
    if (
      !NULLABLE_INT(item.amount_cents) ||
      !NULLABLE_STRING(item.date) ||
      !NULLABLE_INT(item.split_count) ||
      !NULLABLE_INT(item.net_days) ||
      typeof item.rationale !== "string" ||
      item.rationale.length > 300
    ) {
      return { ok: false, detail: `candidates[${i}] has a malformed field` };
    }
    candidates.push({
      lever: item.lever as Lever,
      amount_cents: (item.amount_cents as number | null) ?? null,
      date: (item.date as string | null) ?? null,
      split_count: (item.split_count as number | null) ?? null,
      net_days: (item.net_days as number | null) ?? null,
      rationale: item.rationale,
    });
  }
  return {
    ok: true,
    proposal: {
      roundNote: parsed.round_note,
      done: parsed.done,
      candidates,
    },
  };
}
