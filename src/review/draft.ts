import { createHash } from "node:crypto";
import { canonicalJson } from "../runner/digest.ts";
import type { ScenarioResult } from "../runner/types.ts";
import type { RunReceipt } from "./receipt.ts";

export const DRAFT_VERSION = "caveat-draft/1";

// Public source links for the demo files (see README).
const EDGAR_URLS: Record<string, string> = {
  "01-consulting-agreement.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm",
  "02-first-amendment.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm",
  "03-second-amendment.pdf":
    "https://www.sec.gov/Archives/edgar/data/1855509/000173112226001331/e8000_ex10-1.htm",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// $8,000 when whole dollars, else $8,000.50 — never the "$x,xxx.00" page style.
function money(cents: number): string {
  const grouped = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = cents % 100;
  return rest === 0 ? `$${grouped}` : `$${grouped}.${String(rest).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function formatMonth(iso: string): string {
  const [year, month] = iso.split("-");
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

function sha12(source: { versionLabel: string }): string {
  return source.versionLabel.replace(/^sha256\s+/, "");
}

export function receiptHash(receipt: unknown): string {
  return createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

export function draftHash(draftText: string): string {
  return createHash("sha256").update(draftText, "utf8").digest("hex");
}

// The sentence for one reading of the base retainer under no_extensions.
function readingSentence(
  reading: { id: string; results: Record<string, Record<string, ScenarioResult>> },
  phrase: string,
): string {
  const scenario = Object.values(reading.results)
    .map((s) => s["no_extensions"])
    .find((r) => r !== undefined);
  if (scenario === undefined) return `If the base retainer ${phrase}, the no_extensions scenario was not modeled.`;
  if (scenario.firstBreach !== null) {
    const breach = scenario.firstBreach;
    const entry = scenario.ledger.find(
      (e) => e.date === breach.date && e.balanceCents === breach.balanceCents,
    );
    const escrow = entry?.escrowBalanceCents ?? scenario.endEscrowCents;
    return `If the base retainer ${phrase}, cash first falls below the floor on ${formatDate(breach.date)} (${money(breach.balanceCents)}) while ${money(escrow)} is held in escrow.`;
  }
  return `If the base retainer ${phrase}, cash stays at or above the floor; the lowest balance is ${money(scenario.lowest.balanceCents)} on ${formatDate(scenario.lowest.date)}.`;
}

// Deterministic counteroffer notes from a receipt — caveat-draft/1. Never uses
// the model's free text: every substitution comes from validated structures.
export function renderDraft(receipt: RunReceipt): string {
  const lines: string[] = [];
  lines.push("DRAFT - NOT SENT - NOT LEGAL ADVICE");
  lines.push(`Caveat counteroffer notes (${DRAFT_VERSION})`);
  lines.push(`Run: ${receipt.runId}`);
  lines.push(`Receipt: sha256 ${receiptHash(receipt)}`);
  lines.push(
    "Prepared from these Box files (text renderings of public SEC EDGAR exhibits):",
  );
  for (const source of [...receipt.sources].sort((a, b) =>
    a.fileName.localeCompare(b.fileName),
  )) {
    const url = EDGAR_URLS[source.fileName] ?? source.edgarUrl ?? "";
    lines.push(`- ${source.fileName} (sha256 ${sha12(source)}) ${url}`.trimEnd());
  }
  lines.push("");
  lines.push("Points to raise before relying on the Second Amendment:");
  lines.push("");

  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };

  // 1. Escrow is not cash yet — always included for a reviewable run.
  const schedule =
    receipt.schedule?.outcome.status === "extracted"
      ? receipt.schedule.outcome.schedule
      : undefined;
  const firstRelease = schedule?.releases[0];
  const superseded = receipt.readings.find((r) => r.id === "retainer_superseded");
  const continues = receipt.readings.find((r) => r.id === "retainer_continues");
  const sentences: string[] = [];
  if (superseded !== undefined) {
    sentences.push(readingSentence(superseded, "does not continue"));
  }
  if (continues !== undefined) {
    sentences.push(readingSentence(continues, "continues"));
  }
  if (schedule !== undefined && firstRelease !== undefined) {
    lines.push(
      `${next()}. Escrow is not cash yet. Section 3(b) of the Second Amendment pays compensation for the ${schedule.periodText} period into escrow; the first release to the consultant is ${firstRelease.amountText} on ${formatDate(firstRelease.date)} (Section 3(b)(i)). ${sentences.join(" ")}`,
    );
    lines.push(
      `   Ask: whether part of the escrowed amount can be released before ${formatDate(firstRelease.date)}.`,
    );
  }

  // 2. Base retainer — when the reviewer left it unresolved.
  const review =
    receipt.humanReview.status === "ok" ? receipt.humanReview.review : undefined;
  const reading = review?.baseRetainer.continuesReading;
  if (review?.baseRetainer.answer === "unresolved_compare_both" && reading !== undefined) {
    lines.push(
      `${next()}. Base retainer. Please confirm in writing whether the ${reading.amount.text} in Section 1.3 of the Consulting Agreement continues after the Second Amendment. Section 4 of the Second Amendment says: "Except as expressly amended, all terms of the Consulting Agreement remain unchanged and in full force and effect."`,
    );
  }

  // 3. One item per inverted date range, in flag order.
  for (const flag of receipt.flags) {
    if (flag.kind !== "date_range_inverted") continue;
    lines.push(
      `${next()}. Date in Section ${flag.sectionId.replace(/^§/, "")} of ${flag.fileName}. It reads "${flag.quote}". Please confirm the intended end date.`,
    );
  }

  // 4. First Amendment payment — only when the reviewer recorded none_modeled.
  if (review?.firstAmendmentPay.cashEffectInWindow === "none_modeled") {
    lines.push(
      `${next()}. First Amendment payment. The $25,000 due upon execution of the Agreement and Plan of Merger has no stated date in these documents. Please confirm when it was or will be paid.`,
    );
  }

  // 5. Counteroffer search outcome — only when the search ran and produced a
  // verdict; every substitution is a runner-verified number or compile text.
  const search = receipt.counteroffer;
  if (search !== undefined && search.status === "found" && search.best !== null) {
    const best = search.rounds.flatMap((r) => r.candidates).find((c) => c.id === search.best);
    if (best !== undefined) {
      const bestRound = search.rounds.find((r) => r.candidates.includes(best))?.round;
      const lowest = Object.values(best.perScenario ?? {})
        .flatMap((scenarios) => Object.values(scenarios))
        .reduce<{ date: string; balanceCents: number } | null>(
          (acc, r) => (acc === null || r.lowest.balanceCents < acc.balanceCents ? r.lowest : acc),
          null,
        );
      const lowestPart =
        lowest === null ? "" : ` (lowest ${money(lowest.balanceCents)} on ${formatDate(lowest.date)})`;
      const boundRecord =
        search.bound === null || search.bound === undefined
          ? undefined
          : search.rounds.flatMap((r) => r.candidates).find((c) => c.id === search.bound?.candidate);
      const boundPart =
        boundRecord === undefined
          ? ""
          : ` A smaller version (${boundRecord.summary ?? boundRecord.id}) failed the same tests.`;
      lines.push(
        `${next()}. Proposed change, tested by Caveat: ${best.summary ?? best.id}. This moves ${money(best.rankCents ?? 0)} earlier than the signed terms and adds no new money. Caveat's runner tested it against both extension cases under both retainer readings; cash stays at or above the ${money(receipt.assumptions.floorCents)} floor in all four${lowestPart}.${boundPart} It was found in round ${bestRound ?? "?"} of the search; the receipt lists every candidate tried.`,
      );
    }
  } else if (search !== undefined && search.status === "not_found") {
    lines.push(
      `${next()}. No tested change within ${search.rounds.length} rounds kept cash at or above the floor in every scenario; the receipt lists every candidate tried.`,
    );
  }

  lines.push("");
  const a = receipt.assumptions;
  const firstCost = a.costs[0];
  const lastCost = a.costs[a.costs.length - 1];
  const months =
    firstCost !== undefined && lastCost !== undefined
      ? `${formatMonth(firstCost.date)} to ${formatMonth(lastCost.date)}`
      : "the modeled months";
  // The example adjustment is the first one for release-1.
  let policyExample = "";
  for (const r of receipt.readings) {
    const found = r.adjustments
      .flatMap((s) => s.adjustments)
      .find((adj) => adj.ruleId === "release-1");
    if (found !== undefined) {
      policyExample = `; for example, ${formatDate(found.contractDate)} is modeled as ${formatDate(found.modeledDate)}`;
      break;
    }
  }
  lines.push(
    `Cash figures use demo assumptions, not facts about the parties: opening cash ${money(a.openingCents)}, cash floor ${money(a.floorCents)}, costs of ${firstCost !== undefined ? money(firstCost.amountCents) : "the stated amount"} on the 15th of each month from ${months}. Payments due on a weekend are counted on the next business day (runner policy${policyExample}).`,
  );
  return `${lines.join("\n")}\n`;
}
