import { dayNumber, weekday } from "../runner/dates.ts";
import type { ScenarioResult } from "../runner/types.ts";
import { escapeHtml, renderDecisionCard } from "./decision-card.ts";
import type { Excerpt } from "../interpret/types.ts";
import type {
  ClientReplyReceipt,
  HumanReviewReceipt,
  ReceiptReading,
  RunReceipt,
} from "./receipt.ts";
import type {
  CounterofferReceipt,
  SearchCandidateRecord,
  SearchRound,
} from "../search/loop.ts";

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

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// "2027-01-02" → "January 2, 2027"
function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}`;
}

function weekdayName(iso: string): string {
  return WEEKDAY_NAMES[weekday(dayNumber(iso))] ?? "";
}

function formatCents(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = String(Math.abs(cents % 100)).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${rest}`;
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "2026-12-15" → "Dec 15, 2026"
function formatDateShort(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${MONTH_ABBR[Number(month) - 1]} ${Number(day)}, ${year}`;
}

// $8,000 whole dollars, else $8,000.50 — headline phrasing drops the cents.
function formatMoneyShort(cents: number): string {
  const grouped = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = cents % 100;
  return rest === 0 ? `$${grouped}` : `$${grouped}.${String(rest).padStart(2, "0")}`;
}

function excerptFor(excerpts: readonly Excerpt[], excerptId: string): Excerpt | undefined {
  return excerpts.find((e) => e.id === excerptId);
}

function sectionName(excerpts: readonly Excerpt[], excerptId: string): string {
  const excerpt = excerptFor(excerpts, excerptId);
  if (excerpt === undefined) return escapeHtml(excerptId);
  const { fileName, section, page } = excerpt.source;
  const sectionPart = section !== undefined ? ` ${escapeHtml(section)}` : "";
  return `${escapeHtml(fileName)}${sectionPart}, page ${page}`;
}

const INCREMENTAL_LABELS: Record<string, string> = {
  release_timing: "release timing",
  escrow_schedule: "escrow schedule",
  counteroffer_search: "counteroffer search",
};

// The "What changed in Box" section — only on runs that were based on a
// previous run (the watcher's incremental reruns).
function renderIncremental(receipt: RunReceipt): string {
  const inc = receipt.incremental;
  if (inc === undefined) return "";

  const files =
    inc.changedFiles.length === 0
      ? "<p>No file-level changes.</p>"
      : `<ul>${inc.changedFiles
          .map((f) => {
            const bytes = f.contentChanged ? "bytes changed" : "bytes unchanged";
            return `<li>${escapeHtml(f.fileName)}: version ${escapeHtml(f.fromVersionTag ?? "—")} → ${escapeHtml(f.toVersionTag ?? "—")} (${bytes})</li>`;
          })
          .join("")}</ul>`;

  const sectionIds = [
    ...inc.changedSections.changed,
    ...inc.changedSections.added,
    ...inc.changedSections.removed,
  ];
  const clauses =
    sectionIds.length === 0
      ? `Clauses changed: 0 of ${inc.totalSections}`
      : `Clauses changed: ${sectionIds.length} of ${inc.totalSections} — ${sectionIds
          .map((id) => escapeHtml(id))
          .join(", ")}`;

  const label = (id: string): string => INCREMENTAL_LABELS[id] ?? id;
  const reran =
    inc.reran.length === 0
      ? "none"
      : inc.reran.map((id) => escapeHtml(label(id))).join(", ");
  const carried =
    inc.carriedForward.length === 0
      ? `nothing carried forward from ${escapeHtml(inc.previousRunId)}`
      : `carried forward from ${escapeHtml(inc.previousRunId)}: ${inc.carriedForward
          .map((id) => escapeHtml(label(id)))
          .join(", ")}`;
  const reverify =
    receipt.counteroffer?.reverifiedOn !== undefined
      ? `; best candidate re-verified on ${escapeHtml(receipt.counteroffer.reverifiedOn)}`
      : "";

  return `<section class="incremental">
  <h2>What changed in Box</h2>
  <p>Compared to ${escapeHtml(inc.previousRunId)}${
    inc.mode === "full_no_baseline" ? " (full run — that run had no digests to compare)" : ""
  }.</p>
  ${files}
  <p>${clauses}.</p>
  <p>Re-asked the model: ${reran}. ${carried}${reverify}.</p>
</section>`;
}

function renderSources(receipt: RunReceipt): string {
  const items = receipt.sources
    .map((s) => {
      const link =
        s.edgarUrl === null
          ? ""
          : ` — <a href="${escapeHtml(s.edgarUrl)}">SEC EDGAR source</a>`;
      const version = s.versionPresent ? "version confirmed" : "version not reported";
      return `  <li><strong>${escapeHtml(s.fileName)}</strong> — ${escapeHtml(s.versionLabel)} (${version})${link}</li>`;
    })
    .join("\n");
  return `<section class="sources">
  <h2>Sources</h2>
  <ul>
${items}
  </ul>
</section>`;
}

function renderReleaseTiming(receipt: RunReceipt): string {
  if (receipt.releaseTiming === null) {
    return `<section class="release-timing">
  <h2>Release timing</h2>
  <p>The release timing question was not run.</p>
</section>`;
  }
  const { outcome, question } = receipt.releaseTiming;
  const override = receipt.overrides.find((o) => o.questionId === question.spec.id);
  const overrideNote =
    override === undefined
      ? ""
      : `\n  <p class="override-note">Human override applied: <strong>${escapeHtml(override.answer)}</strong> (reviewer ${escapeHtml(override.reviewer)}, ${escapeHtml(override.reviewedAt)}).</p>`;
  return `<section class="release-timing">
  <h2>Release timing</h2>
  ${renderDecisionCard(outcome, question)}${overrideNote}
</section>`;
}

function renderSchedule(receipt: RunReceipt): string {
  if (receipt.schedule === null) {
    return `<section class="schedule">
  <h2>Extracted escrow schedule</h2>
  <p>The schedule extraction was not run.</p>
</section>`;
  }
  const { outcome, excerpts } = receipt.schedule;
  if (outcome.status === "needs_review") {
    return `<section class="schedule">
  <h2>Extracted escrow schedule</h2>
  <p>Extraction needs human review: ${escapeHtml(outcome.reason)} — ${escapeHtml(outcome.detail)}</p>
</section>`;
  }
  const s = outcome.schedule;
  const releaseItems = s.releases
    .map((r) => {
      const condition =
        r.conditionText === null
          ? "unconditional"
          : `condition: ${escapeHtml(r.conditionText)}`;
      return `    <li><strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.amountText)} on ${escapeHtml(r.dateText)} (${condition})<br>
      <span class="quote">&ldquo;${escapeHtml(r.quote)}&rdquo;</span> — ${sectionName(excerpts, r.excerptId)}</li>`;
    })
    .join("\n");
  return `<section class="schedule">
  <h2>Extracted escrow schedule</h2>
  <p>Monthly amount: <strong>${escapeHtml(s.monthlyAmountText)}</strong> —
  <span class="quote">&ldquo;${escapeHtml(s.monthlyQuote)}&rdquo;</span> — ${sectionName(excerpts, s.monthlyExcerptId)}</p>
  <p>Escrow period: <strong>${escapeHtml(s.periodText)}</strong> —
  <span class="quote">&ldquo;${escapeHtml(s.periodQuote)}&rdquo;</span> — ${sectionName(excerpts, s.periodExcerptId)}</p>
  <p>Releases out of escrow:</p>
  <ul>
${releaseItems}
  </ul>
</section>`;
}

function citationLines(citations: readonly { fileName: string; section: string; quote: string }[]): string {
  if (citations.length === 0) return "";
  const items = citations
    .map(
      (c) =>
        `    <li><span class="quote">&ldquo;${escapeHtml(c.quote)}&rdquo;</span> — ${escapeHtml(c.fileName)} ${escapeHtml(c.section)}</li>`,
    )
    .join("\n");
  return `  <ul class="citations">\n${items}\n  </ul>`;
}

function renderHumanReview(receipt: RunReceipt): string {
  const hr: HumanReviewReceipt = receipt.humanReview;
  if (hr.status === "needs_review") {
    return `<section class="human-review">
  <h2>Human review</h2>
  <p>The review record is invalid: ${escapeHtml(hr.reason)} — ${escapeHtml(hr.detail)}</p>
</section>`;
  }
  const { review } = hr;
  const base = review.baseRetainer;
  const revisionPart =
    review.revision === undefined ? "" : `, revision ${review.revision}`;
  const baseSummary =
    base.answer === "unresolved_compare_both"
      ? `Retainer after the second amendment: unresolved, comparing both readings (reviewer ${escapeHtml(review.reviewer)}, ${escapeHtml(review.reviewedAt)}${revisionPart})`
      : `Base retainer: ${escapeHtml(base.answer)} (reviewer ${escapeHtml(review.reviewer)}, ${escapeHtml(review.reviewedAt)}${revisionPart})`;
  const baseNote =
    base.note === undefined ? "" : `  <p class="review-note">${escapeHtml(base.note)}</p>\n`;
  const revisionNote =
    review.revisionNote === undefined
      ? ""
      : `  <p class="review-note">Revision note: ${escapeHtml(review.revisionNote)}</p>\n`;
  const reading =
    base.continuesReading === undefined
      ? ""
      : `  <p>Continues reading: ${escapeHtml(base.continuesReading.amount.text)}, paid ${escapeHtml(base.continuesReading.payDay.text)}, through ${escapeHtml(base.continuesReading.termEnd.text)}.</p>
${citationLines([base.continuesReading.amount, base.continuesReading.payDay, base.continuesReading.termEnd])}`;
  const first = review.firstAmendmentPay;
  const cashEffect =
    first.cashEffectInWindow === "none"
      ? "; no cash events in the modeled window"
      : first.cashEffectInWindow === "none_modeled"
        ? "; no cash events modeled in the window"
        : first.cashEffectInWindow !== undefined
          ? `; cash effect in window: ${escapeHtml(first.cashEffectInWindow)}`
          : "";
  const firstNote =
    first.note === undefined ? "" : `  <p class="review-note">${escapeHtml(first.note)}</p>\n`;
  return `<section class="human-review">
  <h2>Human review</h2>
  <p>${baseSummary}</p>
${baseNote}${citationLines(base.citations)}
${reading}
  <p>First-amendment pay: ${escapeHtml(first.answer)}${cashEffect}</p>
${firstNote}${citationLines(first.citations)}
${revisionNote}</section>`;
}

function renderFlags(receipt: RunReceipt): string {
  if (receipt.flags.length === 0) {
    return `<section class="flags">
  <h2>Flags</h2>
  <p>None.</p>
</section>`;
  }
  const items = receipt.flags
    .map((f) => {
      if (f.kind === "date_range_inverted") {
        return `  <li class="flag">Date conflict in ${escapeHtml(f.fileName)} ${escapeHtml(f.sectionId)}: &ldquo;${escapeHtml(f.quote)}&rdquo;. The end date is before the start date. Shown exactly as written; not corrected.</li>`;
      }
      return `  <li class="flag">${escapeHtml(f.kind)} in ${escapeHtml(f.fileName)} ${escapeHtml(f.sectionId)}: &ldquo;${escapeHtml(f.quote)}&rdquo;</li>`;
    })
    .join("\n");
  return `<section class="flags">
  <h2>Flags</h2>
  <ul>
${items}
  </ul>
</section>`;
}

function scenarioRows(results: Record<string, ScenarioResult>): string {
  return Object.entries(results)
    .map(([scenarioId, r]) => {
      const verdict = r.passes ? "pass" : "fail";
      const breach =
        r.firstBreach === null
          ? "none"
          : `${formatDate(r.firstBreach.date)} (week ${r.firstBreach.week}) at ${formatCents(r.firstBreach.balanceCents)}`;
      return `    <tr><td>${escapeHtml(scenarioId)}</td><td>${verdict}</td><td>${escapeHtml(breach)}</td><td>${formatDate(r.lowest.date)} at ${formatCents(r.lowest.balanceCents)}</td><td>${formatCents(r.endBalanceCents)}</td><td>${formatCents(r.endEscrowCents)}</td></tr>`;
    })
    .join("\n");
}

function renderReading(reading: ReceiptReading): string {
  const passing =
    reading.smallestPassingCandidate === null
      ? "none"
      : escapeHtml(reading.smallestPassingCandidate);
  const rows = Object.entries(reading.results)
    .map(
      ([candidateId, scenarios]) => `  <h3>${escapeHtml(reading.label)} — ${escapeHtml(candidateId)}</h3>
  <table>
    <tr><th>Scenario</th><th>Verdict</th><th>First breach</th><th>Lowest balance</th><th>End cash</th><th>End escrow</th></tr>
${scenarioRows(scenarios)}
  </table>`,
    )
    .join("\n");
  return `<article class="reading">
  <p>Smallest passing candidate: <strong>${passing}</strong>. inputDigest <code>${escapeHtml(reading.inputDigest.slice(0, 16))}…</code>, resultDigest <code>${escapeHtml(reading.resultDigest.slice(0, 16))}…</code></p>
${rows}
</article>`;
}

function renderResults(receipt: RunReceipt): string {
  if (receipt.status !== "reviewable" || receipt.readings.length === 0) {
    return `<section class="results">
  <h2>Results</h2>
  <p>No results — this run needs review before results are produced.</p>
</section>`;
  }
  return `<section class="results">
  <h2>Results</h2>
${receipt.readings.map(renderReading).join("\n")}
</section>`;
}

function renderPolicyNotes(receipt: RunReceipt): string {
  const items: string[] = [];
  for (const reading of receipt.readings) {
    for (const { scenarioId, adjustments } of reading.adjustments) {
      for (const a of adjustments) {
        items.push(
          `  <li><strong>${escapeHtml(reading.label)}</strong> / ${escapeHtml(scenarioId)} / ${escapeHtml(a.ruleId)}: Contract date: ${formatDate(a.contractDate)} (${weekdayName(a.contractDate)}). Modeled receipt: ${weekdayName(a.modeledDate)}, ${formatDate(a.modeledDate)}. Runner policy: payments due on a weekend are counted on the next business day; the contract says only ${formatDate(a.contractDate)}.</li>`,
        );
      }
    }
  }
  if (items.length === 0) {
    return `<section class="policy-notes">
  <h2>Runner policy adjustments</h2>
  <p>None.</p>
</section>`;
  }
  return `<section class="policy-notes">
  <h2>Runner policy adjustments</h2>
  <ul>
${items.join("\n")}
  </ul>
</section>`;
}

// "$8,000 under your floor on Dec 15, 2026 while $150,000 sits in escrow" —
// the lowest balance below the floor across the as-signed readings.
function renderHeadline(receipt: RunReceipt): string {
  const floor = receipt.assumptions.floorCents;
  let worst:
    | { label: string; date: string; balanceCents: number; escrowCents: number }
    | undefined;
  for (const reading of receipt.readings) {
    for (const result of Object.values(reading.results.as_signed ?? {})) {
      if (result.lowest.balanceCents >= floor) continue;
      const entry = result.ledger.find(
        (e) => e.date === result.lowest.date && e.balanceCents === result.lowest.balanceCents,
      );
      if (worst === undefined || result.lowest.balanceCents < worst.balanceCents) {
        worst = {
          label: reading.label,
          date: result.lowest.date,
          balanceCents: result.lowest.balanceCents,
          escrowCents: entry?.escrowBalanceCents ?? result.endEscrowCents,
        };
      }
    }
  }
  if (worst === undefined) return "";
  const shortfall = floor - worst.balanceCents;
  const cashCaption =
    receipt.cashSource?.kind === "owner_file"
      ? `Opening cash, floor and costs come from ${escapeHtml(receipt.cashSource.fileName)} (version ${escapeHtml(receipt.cashSource.versionTag)}).`
      : "Opening cash, floor and costs are demo assumptions.";
  return `<p class="headline"><strong>${formatMoneyShort(shortfall)} under your floor on ${escapeHtml(formatDateShort(worst.date))} while ${formatMoneyShort(worst.escrowCents)} sits in escrow</strong><br>
<span class="caption">Reading: ${escapeHtml(worst.label)} (one of two unresolved readings). ${cashCaption}</span></p>`;
}

function renderCashNumbers(receipt: RunReceipt): string {
  const a = receipt.assumptions;
  if (receipt.cashSource?.kind === "owner_file_invalid") {
    const cash = receipt.cashSource;
    return `<p class="caption cash-numbers"><strong>Cash numbers:</strong> ${escapeHtml(cash.fileName)} (version ${escapeHtml(cash.versionTag)}) could not be read: ${escapeHtml(cash.detail)}. No cash results were produced until it is fixed.</p>`;
  }
  const source =
    receipt.cashSource?.kind === "owner_file"
      ? `${escapeHtml(receipt.cashSource.fileName)} (version ${escapeHtml(receipt.cashSource.versionTag)})`
      : "demo assumptions";
  const total = a.costs.reduce((sum, c) => sum + c.amountCents, 0);
  return `<p class="caption cash-numbers"><strong>Cash numbers:</strong> ${source} — opening ${escapeHtml(formatMoneyShort(a.openingCents))} on ${escapeHtml(formatDateShort(a.startDate))}, floor ${escapeHtml(formatMoneyShort(a.floorCents))}, ${a.costs.length} costs totalling ${escapeHtml(formatMoneyShort(total))}.</p>`;
}

function scenarioCount(record: { perScenario?: Record<string, Record<string, unknown>> | undefined }): number {
  return Object.values(record.perScenario ?? {}).reduce(
    (sum, scenarios) => sum + Object.keys(scenarios).length,
    0,
  );
}

function candidateResultCells(record: {
  passesAll?: boolean | undefined;
  perScenario?: Record<string, Record<string, { passes: boolean }>> | undefined;
}): string {
  const lines: string[] = [];
  for (const [reading, scenarios] of Object.entries(record.perScenario ?? {})) {
    for (const [scenario, result] of Object.entries(scenarios)) {
      lines.push(`${escapeHtml(reading)} / ${escapeHtml(scenario)}: ${result.passes ? "pass" : "fail"}`);
    }
  }
  return lines.length === 0 ? "—" : lines.join("<br>");
}

// The outcome banner for one counteroffer search: found with the bound line,
// not_needed, needs_review, or not_found.
// Lowest balance across every tested scenario of the best candidate.
function lowestAcrossScenarios(
  best: SearchCandidateRecord,
): { date: string; balanceCents: number } | null {
  return Object.values(best.perScenario ?? {})
    .flatMap((scenarios) => Object.values(scenarios))
    .reduce(
      (acc, r) => (acc === null || r.lowest.balanceCents < acc.balanceCents ? r.lowest : acc),
      null as { date: string; balanceCents: number } | null,
    );
}

// The bound line under a found banner: the tested failing bound with its
// gap, or the "no smaller candidate" caveat.
function boundLineHtml(
  lever: string,
  boundRecord: SearchCandidateRecord | undefined,
  gap: { unit: string; value: number } | undefined,
): string {
  return boundRecord === undefined
    ? `<br>No smaller ${escapeHtml(lever)} candidate was tested, so this is the smallest passing tested change, not a proven minimum.`
    : `<br>Tested bound: ${escapeHtml(boundRecord.summary ?? boundRecord.id)} fails at least one scenario check (gap ${
        gap?.unit === "days" ? `${gap.value} days` : formatCents(gap?.value ?? 0)
      }).`;
}

// The "found" banner: best summary, scenario coverage with its lowest point,
// change size, the round it was found in, and the tested bound.
function foundOutcomeHtml(
  search: CounterofferReceipt,
  best: SearchCandidateRecord,
  bestRound: number,
): string {
  const lowestAcross = lowestAcrossScenarios(best);
  const lowestPart =
    lowestAcross === null
      ? ""
      : `; lowest ${formatCents(lowestAcross.balanceCents)} on ${escapeHtml(formatDate(lowestAcross.date))}`;
  const boundRecord =
    search.bound === null || search.bound === undefined
      ? undefined
      : search.rounds.flatMap((r) => r.candidates).find((c) => c.id === search.bound?.candidate);
  const boundLine = boundLineHtml(best.lever, boundRecord, search.bound?.gap);
  return `<div class="banner banner--ok"><strong>${escapeHtml(best.summary ?? best.id)}</strong><br>
Passes all ${scenarioCount(best)} tested scenario checks${lowestPart}; change size ${formatCents(best.rankCents ?? 0)}; found in round ${bestRound} of ${search.rounds.length}.${boundLine}</div>`;
}

function counterofferOutcome(search: CounterofferReceipt): string {
  const best = search.best === null ? undefined : search.rounds.flatMap((r) => r.candidates).find(
    (c) => c.id === search.best,
  );
  const bestRound =
    best === undefined ? 0 : (search.rounds.find((r) => r.candidates.includes(best))?.round ?? 0);
  if (search.status === "found" && best !== undefined) {
    return foundOutcomeHtml(search, best, bestRound);
  }
  if (search.status === "not_needed") {
    return `<div class="banner banner--ok"><strong>Not needed.</strong> Both readings already keep cash at or above the floor as signed.</div>`;
  }
  if (search.status === "needs_review") {
    return `<div class="banner banner--blocked"><strong>Counteroffer search needs human review.</strong> ${escapeHtml(search.reason ?? search.stopReason)}${search.detail !== undefined ? ` — ${escapeHtml(search.detail)}` : ""}</div>`;
  }
  return `<div class="banner banner--warn"><strong>No counteroffer found.</strong> No tested change within ${search.rounds.length} rounds kept cash at or above the floor in every scenario.</div>`;
}

function renderCounteroffer(receipt: RunReceipt): string {
  const search = receipt.counteroffer;
  if (search === undefined) return "";

  const outcome = counterofferOutcome(search);
  const roundsHtml = renderSearchRounds(search);

  return `<section class="counteroffer">
  <h2>Counteroffer search</h2>
${outcome}
${roundsHtml}
</section>`;
}

type RejectedCandidate = {
  id: string;
  lever: string;
  rejection: { by: string; code: string; field?: string; detail: string };
};

// One candidate row; rejected candidates are also collected for the review
// table rendered after the rounds.
function candidateRow(c: SearchCandidateRecord, rejected: RejectedCandidate[]): string {
  if (c.rejection !== undefined) {
    rejected.push({ id: c.id, lever: c.lever, rejection: c.rejection });
  }
  const status =
    c.status === "duplicate"
      ? `duplicate of ${escapeHtml(c.duplicateOf ?? "?")}`
      : c.status === "rejected_malformed"
        ? "rejected"
        : c.passesAll === true
          ? "passes"
          : c.passesAll === false
            ? "fails"
            : "tested";
  const terms =
    c.summary !== undefined
      ? escapeHtml(c.summary)
      : `${escapeHtml(c.lever)} (${escapeHtml(JSON.stringify(c.params))})`;
  const changeSize = c.rankCents === undefined ? "—" : formatCents(c.rankCents);
  return `    <tr><td>${escapeHtml(c.id)}<br><span class="caption">${escapeHtml(c.lever)}</span><br><span class="caption">${escapeHtml(c.rationale)}</span></td><td>${terms}</td><td>${escapeHtml(c.worker ?? "—")}</td><td>${candidateResultCells(c)}</td><td>${changeSize}</td><td>${escapeHtml(status)}</td></tr>`;
}

function renderRound(round: SearchRound, model: string, rejected: RejectedCandidate[]): string {
  const rows = round.candidates.map((c) => candidateRow(c, rejected)).join("\n");
  const modelBits = [escapeHtml(model)];
  if (round.modelVersion !== undefined) modelBits.push(escapeHtml(round.modelVersion));
  if (round.servedBy !== undefined) modelBits.push(escapeHtml(round.servedBy));
  const workers = [
    ...new Set(
      round.candidates
        .filter((c) => c.status === "tested" && c.worker !== undefined)
        .map((c) => c.worker as string),
    ),
  ];
  const workerCaption =
    workers.length === 0
      ? ""
      : workers.length === 1
        ? `<p class="caption">Tested on ${escapeHtml(workers[0] ?? "")}</p>`
        : `<p class="caption">Tested in parallel on ${workers.map(escapeHtml).join(", ")}</p>`;
  return `  <h3>Round ${round.round}</h3>
  <p class="model-note">Model's note (model's own words): ${escapeHtml(round.modelNote)} <span class="caption">[${modelBits.join(", ")}]</span></p>
  <table>
    <tr><th>Candidate</th><th>Terms</th><th>Worker</th><th>Result</th><th>Change size</th><th>Status</th></tr>
${rows}
  </table>
${workerCaption}`;
}

// The round tables plus the rejected-candidate review table; shared by the
// main counteroffer search and the client-reply follow-up search.
function renderSearchRounds(search: CounterofferReceipt): string {
  const rejected: RejectedCandidate[] = [];
  const roundsHtml = search.rounds
    .map((round) => renderRound(round, search.model, rejected))
    .join("\n");

  // --- Needs human review ---------------------------------------------------------
  const reviewRows = rejected
    .map(
      (c) =>
        `    <tr><td>${escapeHtml(c.id)}</td><td>${escapeHtml(c.lever)}</td><td>${escapeHtml(c.rejection.by)}</td><td>${escapeHtml(c.rejection.code)}</td><td>${escapeHtml(c.rejection.field ?? "—")}</td><td>${escapeHtml(c.rejection.detail)}</td></tr>`,
    )
    .join("\n");
  const reviewHtml =
    rejected.length === 0
      ? ""
      : `  <h3>Needs human review</h3>
  <table>
    <tr><th>Candidate</th><th>Lever</th><th>Rejected by</th><th>Code</th><th>Field</th><th>Detail</th></tr>
${reviewRows}
  </table>`;
  return `${roundsHtml}
${reviewHtml}`;
}

const SCENARIO_PHRASES: Record<string, string> = {
  no_extensions: "with no extensions granted",
  all_extensions: "with all extensions granted",
};

// "Retainer superseded reading, with or without extensions" — plain words for
// the failing reading/scenario pairs.
function plainCases(
  receipt: RunReceipt,
  cases: { readingId: string; scenarioId: string }[],
): string {
  const byReading = new Map<string, string[]>();
  for (const c of cases) byReading.set(c.readingId, [...(byReading.get(c.readingId) ?? []), c.scenarioId]);
  return [...byReading.entries()]
    .map(([readingId, scenarioIds]) => {
      const label = receipt.readings.find((r) => r.id === readingId)?.label ?? readingId;
      const scenarios =
        scenarioIds.includes("no_extensions") && scenarioIds.includes("all_extensions")
          ? "with or without extensions"
          : scenarioIds.map((id) => SCENARIO_PHRASES[id] ?? id).join(", ");
      return `${label} reading, ${scenarios}`;
    })
    .join("; ");
}

type FailingLowest = {
  lowest: { date: string; balanceCents: number };
  where: string;
};

// The single lowest failing balance, plus every failing scenario that hits
// it, so the verdict names the case in plain words.
function lowestFailingCase(
  receipt: RunReceipt,
  counter: SearchCandidateRecord | undefined,
): FailingLowest | null {
  const failing = Object.entries(counter?.perScenario ?? {}).flatMap(([readingId, scenarios]) =>
    Object.entries(scenarios)
      .filter(([, r]) => !r.passes)
      .map(([scenarioId, r]) => ({ readingId, scenarioId, lowest: r.lowest })),
  );
  const lowestFailing = failing.reduce<(typeof failing)[number] | null>(
    (acc, r) => (acc === null || r.lowest.balanceCents < acc.lowest.balanceCents ? r : acc),
    null,
  );
  if (lowestFailing === null) return null;
  return {
    lowest: lowestFailing.lowest,
    where: plainCases(
      receipt,
      failing.filter(
        (f) =>
          f.lowest.balanceCents === lowestFailing.lowest.balanceCents &&
          f.lowest.date === lowestFailing.lowest.date,
      ),
    ),
  };
}

function replyVerdict(
  receipt: RunReceipt,
  reply: ClientReplyReceipt,
  failingLowest: FailingLowest | null,
): string {
  if (reply.status === "safe") {
    return `  <div class="banner banner--ok"><strong>Safe:</strong> the client's counter keeps cash at or above the floor in every scenario.</div>`;
  }
  if (reply.status === "needs_review") {
    return `  <div class="banner banner--blocked"><strong>Client reply needs human review.</strong> ${escapeHtml(reply.reason ?? "")}${reply.detail !== undefined ? ` — ${escapeHtml(reply.detail)}` : ""}</div>`;
  }
  const notSafe =
    failingLowest === null
      ? "<strong>Not safe:</strong> the client's counter fails at least one scenario check."
      : `<strong>Not safe:</strong> the client's counter leaves a lowest balance of ${formatMoneyShort(failingLowest.lowest.balanceCents)} on ${escapeHtml(formatDateShort(failingLowest.lowest.date))}, ${formatMoneyShort(receipt.assumptions.floorCents - failingLowest.lowest.balanceCents)} under the floor (${escapeHtml(failingLowest.where)}).`;
  return `  <div class="banner banner--warn">${notSafe}</div>`;
}

// The follow-up search block: the counterproposal banner plus the shared
// round tables. Empty when the reply needed no counterproposal.
// The follow-up search's outcome banner: counterproposal found (with its
// tested bound), needs review, or nothing found.
function responseOutcomeHtml(
  response: CounterofferReceipt,
  best: SearchCandidateRecord | undefined,
  boundRecord: SearchCandidateRecord | undefined,
): string {
  if (response.status === "found" && best !== undefined) {
    const boundLine = boundLineHtml(best.lever, boundRecord, response.bound?.gap);
    return `  <div class="banner banner--ok"><strong>Counterproposal: ${escapeHtml(best.summary ?? best.id)}</strong>${boundLine}</div>`;
  }
  if (response.status === "needs_review") {
    return `  <div class="banner banner--blocked"><strong>Reply search needs human review.</strong> ${escapeHtml(response.reason ?? response.stopReason)}${response.detail !== undefined ? ` — ${escapeHtml(response.detail)}` : ""}</div>`;
  }
  return `  <div class="banner banner--warn"><strong>No fix found.</strong> No tested change within ${response.rounds.length} rounds kept cash at or above the floor in every scenario.</div>`;
}

function replyResponseHtml(reply: ClientReplyReceipt): string {
  const response = reply.response;
  if (response === undefined) return "";
  const best =
    response.best === null
      ? undefined
      : response.rounds.flatMap((r) => r.candidates).find((c) => c.id === response.best);
  const boundRecord =
    response.bound === null || response.bound === undefined
      ? undefined
      : (response.rounds
          .flatMap((r) => r.candidates)
          .find((c) => c.id === response.bound?.candidate) ??
        // The bound can be the seed record — it lives in allRecords, not in
        // any round's candidate list.
        (reply.counter?.id === response.bound?.candidate
          ? reply.counter
          : undefined));
  const responseOutcome = responseOutcomeHtml(response, best, boundRecord);
  return `  <h3>Our counterproposal search</h3>
${responseOutcome}
${renderSearchRounds(response)}`;
}

// The client's reply letter: what it proposed, how that tested on every
// worker, and the follow-up search when it failed.
function renderClientReply(receipt: RunReceipt): string {
  const reply = receipt.clientReply;
  if (reply === undefined) return "";

  const head = `  <p class="caption">Client reply letter <code>${escapeHtml(reply.fileName)}</code> (version ${escapeHtml(reply.versionTag)}).</p>`;
  const gateHtml =
    reply.gate === undefined
      ? ""
      : `  <p class="caption">Jev: exactly one payment change, p = ${reply.gate.noul.toFixed(2)}</p>`;
  const quoteHtml =
    reply.citation === undefined
      ? ""
      : `  <h3>The client's words</h3>
  <blockquote>&ldquo;${escapeHtml(reply.citation.quote)}&rdquo;<br><span class="caption">${escapeHtml(reply.citation.excerptId)}${reply.citation.page !== undefined ? `, page ${reply.citation.page}` : ""}</span></blockquote>`;
  const counter = reply.counter;
  const termHtml =
    counter === undefined
      ? ""
      : `  <p>The client proposes: <strong>${escapeHtml(counter.summary ?? `${counter.lever} ${JSON.stringify(counter.params)}`)}</strong></p>`;
  const testedCaption =
    reply.workers === undefined || reply.workers.length === 0
      ? ""
      : `  <p class="caption">Tested on ${reply.workers.map(escapeHtml).join(", ")}</p>`;
  const resultsHtml =
    counter === undefined || counter.perScenario === undefined
      ? ""
      : `  <table>
    <tr><th>Reading / scenario</th><th>Result</th></tr>
    <tr><td colspan="2">${candidateResultCells(counter)}</td></tr>
  </table>
${testedCaption}`;

  const failingLowest = lowestFailingCase(receipt, counter);
  const verdict = replyVerdict(receipt, reply, failingLowest);
  const responseHtml = replyResponseHtml(reply);

  return `<section class="client-reply">
  <h2>Client reply</h2>
${head}
${gateHtml}
${quoteHtml}
${termHtml}
${resultsHtml}
${verdict}
${responseHtml}
</section>`;
}

export const REVIEW_PAGE_CSS = `body{font-family:system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:1rem;line-height:1.45;color:#1a1a1a}
h1{font-size:1.35rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}h3{font-size:1rem}
blockquote{margin:.5rem 0;padding:.5rem .8rem;border-left:3px solid #ccc;background:#f7f7f7}
table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left}
.quote{color:#444}.banner{padding:.6rem .8rem;border-radius:4px;margin:.5rem 0}
.banner--blocked{background:#fdeaea;border:1px solid #e0a0a0}.banner--ok{background:#eaf6ea;border:1px solid #9ecf9e}
.banner--warn{background:#fff8e6;border:1px solid #e0b040}
.flag{background:#fff8e6;padding:.4rem .6rem}code{font-size:.85em;word-break:break-all}
.headline{font-size:1.1rem;margin:1rem 0}.caption{color:#555;font-size:.82rem}
.model-note{color:#333;font-style:italic}
@media (max-width:48rem){table{display:block;overflow-x:auto}
table.runs tr:has(th){display:none}table.runs tr{display:block;border:1px solid #ddd;border-radius:4px;margin:.5rem 0;padding:.2rem 0}table.runs td{display:block;border:0}}`;

export function renderReviewBody(receipt: RunReceipt): string {
  const blocked = receipt.status === "needs_review";
  const banner = blocked
    ? `<div class="banner banner--blocked"><strong>Blocked — this run needs human review.</strong><ul>${receipt.blockedReasons
        .map((r) => `<li>${escapeHtml(r.reason)}: ${escapeHtml(r.detail)}</li>`)
        .join("")}</ul></div>`
    : `<div class="banner banner--ok"><strong>Reviewable.</strong> All checks passed; results below.</div>`;
  return `<h1>Caveat — contract cash review</h1>
<p>Run <code>${escapeHtml(receipt.runId)}</code>. Questions: ${receipt.questionIds.map((q) => escapeHtml(q)).join(", ")}.</p>
${banner}
${renderHeadline(receipt)}
${renderCashNumbers(receipt)}
${renderIncremental(receipt)}
${renderSources(receipt)}
${renderReleaseTiming(receipt)}
${renderSchedule(receipt)}
${renderHumanReview(receipt)}
${renderFlags(receipt)}
${renderResults(receipt)}
${renderCounteroffer(receipt)}
${renderClientReply(receipt)}
${renderPolicyNotes(receipt)}`;
}

export function renderReviewPage(
  receipt: RunReceipt,
  opts: { cssHref?: string } = {},
): string {
  const style =
    opts.cssHref !== undefined
      ? `<link rel="stylesheet" href="${escapeHtml(opts.cssHref)}">`
      : `<style>${REVIEW_PAGE_CSS}</style>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caveat review — ${escapeHtml(receipt.runId)}</title>
${style}
</head>
<body>
${renderReviewBody(receipt)}
</body>
</html>`;
}
