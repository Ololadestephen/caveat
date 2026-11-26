import { createHash } from "node:crypto";
import { TERMS_READING_LABELS } from "../plan/terms.ts";
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

// The "Your reply" block — only for a client counter that tested safe or
// countered; a needs_review or no_fix reply blocks the run, so the draft is
// never exportable then anyway.
function replyLines(receipt: RunReceipt): string[] {
  const reply = receipt.clientReply;
  if (
    reply === undefined ||
    (reply.status !== "safe" && reply.status !== "countered") ||
    reply.counter === undefined
  ) {
    return [];
  }
  const summary = reply.counter.summary ?? reply.counter.lever;
  if (reply.status === "safe") {
    const quotePart =
      reply.citation !== undefined
        ? `, quoted from your letter: "${reply.citation.quote}"`
        : "";
    return [
      `Your reply (${reply.fileName}, version ${reply.versionTag}): Your proposal (${summary}${quotePart}) keeps our cash at or above the floor in every case we tested. We can accept it as written.`,
      "",
    ];
  }
  const failing = Object.values(reply.counter.perScenario ?? {})
    .flatMap((scenarios) => Object.values(scenarios))
    .filter((r) => !r.passes)
    .reduce<{ date: string; balanceCents: number } | null>(
      (acc, r) => (acc === null || r.lowest.balanceCents < acc.balanceCents ? r.lowest : acc),
      null,
    );
  const underPart =
    failing === null
      ? "still fails at least one scenario check"
      : `still leaves cash ${money(receipt.assumptions.floorCents - failing.balanceCents)} under our floor on ${formatDate(failing.date)}`;
  const response = reply.response;
  const best =
    response !== undefined && response.best !== null
      ? response.rounds.flatMap((r) => r.candidates).find((c) => c.id === response.best)
      : undefined;
  const insteadPart =
    best === undefined
      ? " No tested alternative passed every scenario."
      : ` We propose instead: ${best.summary ?? best.id}.`;
  const boundRecord =
    response?.bound === null || response?.bound === undefined
      ? undefined
      : response.rounds.flatMap((r) => r.candidates).find((c) => c.id === response.bound?.candidate);
  const boundPart =
    boundRecord === undefined
      ? ""
      : ` A smaller version (${boundRecord.summary ?? boundRecord.id}) failed the same tests.`;
  return [
    `Your reply (${reply.fileName}, version ${reply.versionTag}): Your proposal (${summary}) ${underPart}.${insteadPart}${boundPart}`,
    "",
  ];
}

// The counteroffer verdict line — only when the search ran and produced a
// verdict; every substitution is a runner-verified number or compile text.
function counterofferLines(receipt: RunReceipt, next: () => number): string[] {
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
      return [
        `${next()}. Proposed change, tested by Caveat: ${best.summary ?? best.id}. This moves ${money(best.rankCents ?? 0)} earlier than the signed terms and adds no new money. Caveat's runner tested it against both extension cases under both retainer readings; cash stays at or above the ${money(receipt.assumptions.floorCents)} floor in all four${lowestPart}.${boundPart} It was found in round ${bestRound ?? "?"} of the search; the receipt lists every candidate tried.`,
      ];
    }
    return [];
  }
  if (search !== undefined && search.status === "not_found") {
    return [
      `${next()}. No tested change within ${search.rounds.length} rounds kept cash at or above the floor in every scenario; the receipt lists every candidate tried.`,
    ];
  }
  return [];
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

  lines.push(...replyLines(receipt));

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
  lines.push(...counterofferLines(receipt, next));

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
  const cash = receipt.cashSource;
  if (cash?.kind === "owner_file_invalid") {
    lines.push(
      `${cash.fileName} (version ${cash.versionTag}) could not be read: ${cash.detail}. No cash results were produced until it is fixed.`,
    );
    return `${lines.join("\n")}\n`;
  }
  if (cash?.kind === "owner_file") {
    const total = a.costs.reduce((sum, c) => sum + c.amountCents, 0);
    lines.push(
      `Cash figures come from your file ${cash.fileName} (version ${cash.versionTag}): opening cash ${money(a.openingCents)} on ${formatDate(a.startDate)}, cash floor ${money(a.floorCents)}, ${a.costs.length} costs totalling ${money(total)} from ${months}. Payments due on a weekend are counted on the next business day (runner policy${policyExample}).`,
    );
  } else {
    lines.push(
      `Cash figures use demo assumptions, not facts about the parties: opening cash ${money(a.openingCents)}, cash floor ${money(a.floorCents)}, costs of ${firstCost !== undefined ? money(firstCost.amountCents) : "the stated amount"} on the 15th of each month from ${months}. Payments due on a weekend are counted on the next business day (runner policy${policyExample}).`,
    );
  }
  return `${lines.join("\n")}\n`;
}


// Picks the draft renderer for the run's contract.
export function renderDraftFor(receipt: RunReceipt, contract: string): string {
  return contract === "twinvee" ? renderDraft(receipt) : renderTermsDraft(receipt);
}

// The generic payment-terms draft — same deterministic discipline as the
// escrow draft: every substitution comes from validated receipt fields.
export function renderTermsDraft(receipt: RunReceipt): string {
  const lines: string[] = [];
  lines.push("DRAFT - NOT SENT - NOT LEGAL ADVICE");
  lines.push(`Caveat contract notes (${DRAFT_VERSION})`);
  lines.push(`Run: ${receipt.runId}`);
  lines.push(`Receipt: sha256 ${receiptHash(receipt)}`);
  lines.push(
    "Prepared from these Box files (text renderings of public SEC EDGAR exhibits):",
  );
  for (const source of [...receipt.sources].sort((a, b) =>
    a.fileName.localeCompare(b.fileName),
  )) {
    const url = source.edgarUrl ?? EDGAR_URLS[source.fileName] ?? "";
    lines.push(`- ${source.fileName} (sha256 ${sha12(source)}) ${url}`.trimEnd());
  }
  lines.push("");
  lines.push("Questions to raise before relying on this agreement:");
  lines.push("");

  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };

  // 1. The partial-month ambiguity is always raised when terms were confirmed.
  const terms =
    receipt.paymentTerms?.outcome.status === "extracted"
      ? receipt.paymentTerms.outcome.terms
      : undefined;
  if (terms !== undefined && terms.termStart !== null && terms.termEnd !== null) {
    const billed = receipt.readings.find((r) => r.id === "partial_months_prorated");
    const notBilled = receipt.readings.find(
      (r) => r.id === "partial_months_not_billed",
    );
    const fee = terms.terms.find(
      (t) => t.kind === "fixed_date_payment" && t.recurrence === "monthly",
    );
    const feeText = fee?.amountText ?? "the monthly fee";
    const billedCount =
      billed === undefined
        ? "every"
        : String(
            Object.values(billed.results.as_signed?.on_time?.ledger ?? []).filter(
              (e) => e.kind === "payment",
            ).length,
          );
    const notBilledCount =
      notBilled === undefined
        ? "fewer"
        : String(
            Object.values(
              notBilled.results.as_signed?.on_time?.ledger ?? [],
            ).filter((e) => e.kind === "payment").length,
          );
    lines.push(
      `${next()}. The agreement does not say whether partial months are billed. One reading bills ${feeText} pro rata by calendar day on the last day of every calendar month that overlaps the term (${terms.termStart.text} – ${terms.termEnd.text}); the other invoices only for calendar months wholly inside it. Caveat ran both readings — ${TERMS_READING_LABELS.partial_months_prorated} produces ${billedCount} invoices, ${TERMS_READING_LABELS.partial_months_not_billed} ${notBilledCount}.`,
    );
    lines.push("   Ask: which reading the parties intend, and whether May and September invoice in full.");
  }

  // 2. The shortfall, in the same words as the page headline.
  const floor = receipt.assumptions.floorCents;
  let worst: { label: string; date: string; balanceCents: number } | undefined;
  for (const reading of receipt.readings) {
    for (const [scenarioId, result] of Object.entries(reading.results.as_signed ?? {})) {
      if (result.lowest.balanceCents >= floor) continue;
      if (worst === undefined || result.lowest.balanceCents < worst.balanceCents) {
        worst = {
          label: `${reading.label} / ${scenarioId}`,
          date: result.lowest.date,
          balanceCents: result.lowest.balanceCents,
        };
      }
    }
  }
  if (worst !== undefined) {
    lines.push(
      `${next()}. Cash falls short of the floor: the lowest modeled balance is ${money(worst.balanceCents)} on ${formatDate(worst.date)}, ${money(floor - worst.balanceCents)} under the floor (${worst.label}).`,
    );
  }

  // 3. The tested fix, only when a counteroffer search found one.
  const search = receipt.counteroffer;
  if (search !== undefined && search.status === "found" && search.best !== null) {
    const best = search.rounds
      .flatMap((r) => r.candidates)
      .find((c) => c.id === search.best);
    if (best !== undefined) {
      lines.push(
        `${next()}. Proposed change, tested by Caveat: ${best.summary ?? best.id}. Caveat's runner tested it against both scenarios under both readings; the receipt lists every candidate tried.`,
      );
    }
  }
  lines.push("");
  return lines.join("\n") + "\n";
}
