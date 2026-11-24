import { dayNumber, weekday } from "../runner/dates.ts";
import type { ScenarioResult } from "../runner/types.ts";
import { escapeHtml, renderDecisionCard } from "./decision-card.ts";
import type { Excerpt } from "../interpret/types.ts";
import type {
  HumanReviewReceipt,
  ReceiptReading,
  RunReceipt,
} from "./receipt.ts";

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

export const REVIEW_PAGE_CSS = `body{font-family:system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:1rem;line-height:1.45;color:#1a1a1a}
h1{font-size:1.35rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}h3{font-size:1rem}
blockquote{margin:.5rem 0;padding:.5rem .8rem;border-left:3px solid #ccc;background:#f7f7f7}
table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left}
.quote{color:#444}.banner{padding:.6rem .8rem;border-radius:4px;margin:.5rem 0}
.banner--blocked{background:#fdeaea;border:1px solid #e0a0a0}.banner--ok{background:#eaf6ea;border:1px solid #9ecf9e}
.banner--warn{background:#fff8e6;border:1px solid #e0b040}
.flag{background:#fff8e6;padding:.4rem .6rem}code{font-size:.85em;word-break:break-all}
@media (max-width:48rem){table{display:block;overflow-x:auto}}`;

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
${renderSources(receipt)}
${renderReleaseTiming(receipt)}
${renderSchedule(receipt)}
${renderHumanReview(receipt)}
${renderFlags(receipt)}
${renderResults(receipt)}
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
