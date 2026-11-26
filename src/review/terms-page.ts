// The review page for the generic payment-terms path: the extracted terms
// table with its Jev cross-check and reviewer decision, the unresolved
// partial-month readings, and the shared cash/incremental/results sections.
import type { PaymentTermsOutcome, ValidatedPaymentTerms, ValidatedTerm } from "../interpret/payment-terms.ts";
import { TERM_KIND_LABELS } from "../interpret/payment-terms.ts";
import type { JevCrosscheck } from "../interpret/types.ts";
import type { RunReceipt } from "./receipt.ts";
import { escapeHtml } from "./decision-card.ts";
import {
  formatDateShort,
  formatMoneyShort,
  renderCashNumbers,
  renderFlags,
  renderIncremental,
  renderPolicyNotes,
  renderResults,
  renderSources,
} from "./review-page.ts";

function kindLabel(term: ValidatedTerm): string {
  return TERM_KIND_LABELS[term.kind] ?? term.kind;
}

// "$5,000.00 per month" / "net 30 days" / "$2,000 on June 1, 2024" — the
// parsed value, in words, from the validated fields only.
function parsedValue(term: ValidatedTerm): string {
  const parts: string[] = [];
  if (term.amountText !== null) {
    parts.push(
      term.amountCents === null
        ? escapeHtml(term.amountText)
        : `${formatMoneyShort(term.amountCents)} (${escapeHtml(term.amountText)})`,
    );
  }
  if (term.dateText !== null) parts.push(escapeHtml(term.dateText));
  if (term.recurrenceText !== null) parts.push(escapeHtml(term.recurrenceText));
  if (term.netDays !== null) parts.push(`net ${term.netDays} days`);
  return parts.join(", ");
}

// Same headline shape as the escrow path, minus the escrow clause when no
// escrow balance exists anywhere in the readings.
function renderTermsHeadline(receipt: RunReceipt): string {
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
  const escrowPart =
    worst.escrowCents > 0 ? ` while ${formatMoneyShort(worst.escrowCents)} sits in escrow` : "";
  const cashCaption =
    receipt.cashSource?.kind === "owner_file"
      ? `Opening cash, floor and costs come from ${escapeHtml(receipt.cashSource.fileName)} (version ${escapeHtml(receipt.cashSource.versionTag)}).`
      : "Opening cash, floor and costs are demo assumptions.";
  return `<p class="headline"><strong>${formatMoneyShort(shortfall)} under your floor on ${escapeHtml(formatDateShort(worst.date))}${escrowPart}</strong><br>
<span class="caption">Reading: ${escapeHtml(worst.label)} (one of two unresolved readings). ${cashCaption}</span></p>`;
}

// The terms table: kind, verbatim quote, clause, parsed value, Jev p and the
// reviewer's decision — one row per extracted term in document order.
function renderTermsSection(receipt: RunReceipt): string {
  const paymentTerms = receipt.paymentTerms;
  if (paymentTerms === undefined) {
    return `<section class="terms">
  <h2>Extracted payment terms</h2>
  <p>The terms extraction was not run.</p>
</section>`;
  }
  const { outcome, crosscheck, confirmation, termClause } = paymentTerms;
  let terms: ValidatedPaymentTerms | undefined;
  if (outcome.status === "extracted") {
    terms = outcome.terms;
  } else if (outcome.partialTerms !== undefined) {
    terms = outcome.partialTerms;
  } else {
    return `<section class="terms">
  <h2>Extracted payment terms</h2>
  <p class="verdict verdict--blocked">needs_review: ${escapeHtml(outcome.reason)} — ${escapeHtml(outcome.detail)}</p>
</section>`;
  }
  const checks = new Map((crosscheck ?? []).map((c) => [c.question, c]));
  const decisions = new Map(
    (confirmation?.status === "confirmed" ? confirmation.decisions : []).map(
      (d) => [d.termId, d],
    ),
  );
  const rejected = confirmation?.status === "needs_review" && confirmation.reason === "term_rejected";
  const rows = terms.terms
    .map((term) => {
      const check: JevCrosscheck | undefined = checks.get(`term_${term.id}`);
      const jev = check === undefined ? "—" : `p = ${check.noul.toFixed(2)}`;
      const decision = decisions.get(term.id);
      const reviewer =
        decision === undefined
          ? rejected
            ? "rejected"
            : "unconfirmed"
          : `confirmed by ${escapeHtml(decision.reviewer)}`;
      const dateCell =
        term.dateQuote === null
          ? ""
          : `<br><span class="mono">date: ${escapeHtml(term.dateQuote)}</span>`;
      const dateClause =
        term.dateExcerptId === null ? "" : `<br>date: ${escapeHtml(term.dateExcerptId)}`;
      return `    <tr><td>${escapeHtml(kindLabel(term))}</td><td>${escapeHtml(term.quote)}${dateCell}</td><td>${escapeHtml(term.excerptId)}${dateClause}</td><td>${parsedValue(term)}</td><td>${jev}</td><td>${reviewer}</td></tr>`;
    })
    .join("\n");
  const blocked =
    outcome.status === "extracted"
      ? ""
      : `  <p class="verdict verdict--blocked">needs_review: ${escapeHtml(outcome.reason)} — ${escapeHtml(outcome.detail)}</p>\n`;
  const pick =
    termClause === undefined
      ? ""
      : `  <p class="caption">Jev term-clause pick: ${escapeHtml(termClause.choice)} (${escapeHtml(termClause.probabilities[termClause.choice]?.toFixed(2) ?? "—")})${termClause.narrowed ? "; narrowed the bounds extraction to that excerpt" : ""}.</p>\n`;
  const boundsCite =
    terms.termStart !== null && terms.termEnd !== null && terms.boundsFrom === "term_bounds"
      ? ` <br>from term_bounds call: "${escapeHtml(terms.termStart.quote)}" / "${escapeHtml(terms.termEnd.quote)}" (${escapeHtml(terms.termStart.excerptId)} / ${escapeHtml(terms.termEnd.excerptId)})`
      : "";
  const bounds =
    terms.termStart !== null && terms.termEnd !== null
      ? `<p class="caption">Term: ${escapeHtml(terms.termStart.text)} – ${escapeHtml(terms.termEnd.text)} (${escapeHtml(terms.termStart.excerptId)}).${boundsCite}</p>`
      : "";
  const extras =
    confirmation === undefined || confirmation.extras.length === 0
      ? ""
      : `  <p class="caption">Review entries matching no extracted term (ignored): ${confirmation.extras
          .map((e) => `${escapeHtml(e.kind)} at ${escapeHtml(e.excerptId)}`)
          .join("; ")}</p>\n`;
  const carriedFrom = outcome.status === "extracted" ? outcome.carriedFrom : undefined;
  const carried = carriedFrom === undefined ? "" : ` (carried from ${escapeHtml(carriedFrom)})`;
  return `<section class="terms">
  <h2>Extracted payment terms</h2>
  <p class="caption">Extracted by ${escapeHtml(outcome.provider)} ${escapeHtml(outcome.model ?? "unknown model")}${carried}; cross-checked by Jev; each term confirmed by the reviewer file before results run.</p>
  <p class="caption"><strong>The agreement does not say whether partial months are billed</strong> — both readings run below; invoice receipt date is not stated and is modeled as received on the invoice date.</p>
${blocked}${pick}${bounds}
  <table>
    <tr><th>Kind</th><th>Verbatim quote</th><th>Clause</th><th>Parsed value</th><th>Jev p</th><th>Reviewer</th></tr>
${rows}
  </table>
${extras}</section>`;
}

export function renderTermsReviewBody(receipt: RunReceipt): string {
  const blocked = receipt.status === "needs_review";
  const banner = blocked
    ? `<div class="banner banner--blocked"><strong>Blocked — this run needs human review.</strong><ul>${receipt.blockedReasons
        .map((r) => `<li>${escapeHtml(r.reason)}: ${escapeHtml(r.detail)}</li>`)
        .join("")}</ul></div>`
    : `<div class="banner banner--ok"><strong>Reviewable.</strong> All checks passed; results below.</div>`;
  return `<h1>Caveat — contract cash review</h1>
<p>Run <code>${escapeHtml(receipt.runId)}</code>.</p>
${banner}
${renderTermsHeadline(receipt)}
${renderCashNumbers(receipt)}
${renderIncremental(receipt)}
${renderSources(receipt)}
${renderTermsSection(receipt)}
${renderFlags(receipt)}
${renderResults(receipt)}
<section class="counteroffer">
  <h2>Counteroffer search</h2>
  <p>Counteroffer search is not available for this contract type yet.</p>
</section>
${renderPolicyNotes(receipt)}`;
}

// The PaymentTermsOutcome import is used in JSDoc-facing signatures above.
export type { PaymentTermsOutcome };
