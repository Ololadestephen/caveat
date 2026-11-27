# Caveat

Caveat reads a consultant's contract documents from Box, has TypeSafe's Jev
make typed decisions about the payment terms, and stress-tests the answers against a
deterministic cash-flow model before anyone signs. Every run ends in a
receipt that a human must approve; the export is a draft counteroffer note —
never sent, never legal advice.

**Demo video (1 min 52 s):** https://youtu.be/tmyJL_PotMQ

Built for [Fly.io Hacksgiving](https://fly.io/hacksgiving/) (Nov 23–29, 2026).
It runs on Fly.io Sprites (one coordinator and two isolated worker Sprites) and
uses five Sprites Connectors: Box, TypeSafeAI (Jev), OpenRouter, and one
connector per worker.

## The demo story: Twin Vee escrow

The live evidence is a text rendering of three public SEC EDGAR exhibits from
Twin Vee PowerCats Co.: a consulting agreement and its two amendments.
A Caveat run on them surfaces five things a reader can miss:

- **Escrow is not cash.** The Second Amendment pays six months of compensation
  into escrow; the first release to the consultant is months away. Under the
  reading where the old retainer stops, the cash runner shows cash falling below
  the floor while $150,000 sits in escrow — so the first question to raise is
  whether part of the escrowed amount can be released early.
- **An impossible date.** Section 3(c) reads "from December 31, 2026 until
  March 31, 2026" — flagged verbatim, never silently corrected.
- **A retainer ambiguity.** The amendments never say whether the original
  monthly retainer continues; Caveat runs the cash model under both readings
  and reports each outcome separately rather than picking one.
- **A tested fix.** A counteroffer search asks the model for candidate term
  changes, runs them in parallel on the worker Sprites, feeds the runner's
  results back and narrows for up to four rounds, keeping the smallest tested
  change that holds cash at or above the floor in every scenario, alongside
  the closest smaller change that failed.
- **Stale approval.** Approvals pin the exact Box version of every source
  file. The coordinator watches the Box folder; when the amendment is
  re-uploaded as a new Box version (same bytes), the old approval is marked
  `stale`, its export is refused, and a fresh draft goes into review.
- **Your own cash numbers.** A `my-cash.csv` in the Box folder (opening
  balance, cash floor, dated costs) replaces the demo assumptions. It is
  validated strictly; an invalid file blocks the run with its line number
  instead of falling back. A new version replans like a document change.
- **The client's reply.** When `04-client-reply.pdf` lands in Box, Jev first
  checks that it proposes exactly one payment change, the OpenRouter model
  copies that change verbatim with its clause, and code parses it into the
  same typed lever fields the search uses. Both workers test it and must
  agree. A safe counter is marked safe; an unsafe one starts a follow-up
  search seeded with the client's offer, and the draft proposes the tested
  fix. Anything not read cleanly goes to human review. Nothing is sent.

## Second contract: Aviat Networks

The same pipeline runs on a different contract with no code forks: an Aviat US
independent-contractor agreement,
[a public SEC EDGAR exhibit](https://www.sec.gov/Archives/edgar/data/1377789/000137778924000024/consultingagreement05282024.htm).
Its two Box files (`01-agreement.pdf`, `02-exhibit-a.pdf`) are text renderings
of the agreement body and Exhibit A only — Exhibits B and C are omitted.

- **Generic extraction.** The model copies each payment term verbatim with
  its clause: net-30 payment terms in `01-agreement.pdf` §2(a) and
  `02-exhibit-a.pdf` §3.3, and the $5,000/month fee in §3.1 whose invoice-day
  rule ("the last day of the invoiced month") sits in §3.2 — a term may cite a
  second excerpt for its date rule. Jev cross-checks each term against its own
  quote (p = 0.85 / 0.93 / 0.92).
- **A staged term-bounds pass.** When a recurring fee needs the agreement's
  bounds and the main extraction leaves them unstated, a Jev choice picks the
  term clause (`e16`, §9 "Term", p = 0.99) and a second extraction reads just
  the dates from it: May 29, 2024 – September 29, 2024.
- **Confirmation bound to the extraction.** The reviewer's file confirms the
  exact verbatim terms *of a named run* (`extractedIn`); the run that produced
  them need not have reached reviewable, since only the review gate blocked
  it. Entries that don't match that run's terms leave the run
  `needs_review | terms_unconfirmed`.
- **Two readings again.** The agreement does not say whether partial months
  are billed: the owner's reading bills the fee pro rata by calendar day in
  whole dollars ($484 for May, $4,833 for September, $5,000 in between); the
  other invoices only whole months inside the term. Both run under the
  `on_time` and `paid_15_days_late` scenarios.
- **Demo cash, labeled.** With no `my-cash.csv` in the folder, opening
  balance, floor and costs come from the demo-assumptions fixture and are
  labeled as such on the page and in the draft.
- **Live proof.** `run-20261126-192834-406d` ended `reviewable` with every
  typed call carried from the confirmed extraction, both readings run on both
  worker Sprites with identical result digests matching the coordinator's,
  and the same digests reproduced by an independent recompute on the runner.
  Runner code changed: **0 lines** — the same deterministic runner digested
  every scenario. Cash falls below the demo floor in every scenario (worst
  -$7,000 on Dec 15, 2024 under the not-billed reading); that is a result,
  not a failure.
- **Not yet.** The counteroffer search is not available for this contract
  type yet; the review page says so explicitly.

## Architecture

- **Coordinator Sprite** (`caveat-coord`): runs the `caveat` HTTP service
  (`src/server/`, `node:http`, no framework, no added dependencies). Runs
  live in a `node:sqlite` database (`src/store/db.ts`) — receipt and draft
  fields are immutable once written (enforced by triggers), status flows
  `running → reviewable → approved`, with `stale`, `needs_review`, `failed`
  and `superseded` states kept visible. A run interrupted mid-flight becomes
  a `failed` row on restart, not a silent disappearance.
- **Connectors**: the only route to Box, TypeSafe and OpenRouter is the
  coordinator's Sprite connectors, scoped by an access policy (the proof
  folder's `/2.0/folders/*` and `/2.0/files/*` endpoints, `/v1/systemone`
  for the TypeSafeAI connector, and `/v1/chat/completions` for OpenRouter).
  The Box, TypeSafe and OpenRouter keys are held by the connectors
  and never reach this repo, the operator's machine or any Sprite. The
  operator's machine holds only its `sprite` CLI login, which the proof
  scripts use through `sprite exec` and `sprite proxy`; the coordinator
  holds no org token.
- **Typed decisions with Jev** (`src/interpret/jev.ts`): Jev
  (`jev-1.14.0`, pinned) answers through the TypeSafeAI connector's
  `/v1/systemone`. It makes three decisions: the release-timing choice
  (cash on fixed dates, escrow release, transaction-triggered, or
  ambiguous), a follow-up choice of which excerpt states the first release
  (asked only after a confident decision, worded for the chosen answer),
  and a yes/no gate on whether the client's letter proposes exactly one
  payment change. The review page shows Jev's probabilities for every
  option. An answer below 0.80 confidence, or an "ambiguous" choice, goes
  to human review. Jev only decides; text extraction (the escrow schedule,
  the client's terms) and the counteroffer search use the OpenRouter model,
  and code validates every copied quote and parses every amount and date.
- **Counteroffer search** (`src/search/`): each round the model proposes 2
  or 3 candidates as strict JSON, each using a different lever. The four
  levers move money already in the deal earlier: a cash deposit at signing,
  an earlier escrow release, a monthly split of that release, or shorter
  payment terms. A proposal that repeats a lever in a round, or offers fewer
  than two candidates before it says it is done, stops the search for human
  review. The coordinator compiles each candidate into payment rules and
  splits the round's candidates across `caveat-wa` and `caveat-wb`, which run
  them at the same time under both retainer readings and both extension
  cases. The runner's results go back to the model with a per-lever bracket
  (smallest passing and largest failing value tested so far), and the model
  narrows the bracket in the next round. The search stops when the model
  says it is done or after four rounds. The model never supplies a balance:
  the runner is the only source of numbers, and "smallest" means the fewest
  dollars paid earlier than the signed terms. The review page and draft show
  the closest smaller candidate of the same lever that failed, or say that
  no smaller one was tested and the result is not a proven minimum.
  Candidates that fail validation or that the runner rejects are listed for
  human review. Every round (candidates, worker, results and the model's
  note on why it moved on) is on the review page.
- **Box watcher** (`src/watch/`): while the coordinator is awake it checks
  the Box folder's file versions every 60 s. A new version marks approved
  and reviewable runs on the old version `stale` and starts a new run that
  re-asks the model only when the text it would see has changed. Unchanged
  answers are carried forward with a pointer to the run they came from, and
  the deterministic steps always rerun. Sprites pause when idle and the
  watcher pauses with them; the next request wakes it and it checks again.
  It never uploads to Box or sends anything.
- **Worker Sprites** (`caveat-wa`, `caveat-wb`): hold no Box, TypeSafe or
  OpenRouter grants at all; all three connectors refuse them (403). The coordinator reaches them through one Custom API
  connector per worker (`caveat-worker-a`, `caveat-worker-b`) pointing at
  that worker's org-private Sprite URL and restricted to `/run-batch`; the
  gateway refuses connectors that target the Sprites API itself, so workers
  serve a small HTTP endpoint instead of being driven by exec. The token
  lives in the connector, not in any Sprite. The
  coordinator checks that each worker's input digest matches what it sent.
  The worker proof pushes a fixture bundle, runs it under a
  per-worker overlay, checkpoints the Sprite, restores it, and replays —
  showing deterministic digests, overlay isolation between workers, and that
  only the pre-existing checkpoint remains afterwards.
- **Controller**: the coordinator drives the workers during a run. The
  deploy and proof scripts under `scripts/` run on the operator's machine.
  Workers never approve or export; there is no code path from a worker into
  those handlers.

## What is live, synthetic, or assumed

- **Live**: the three source PDFs in the Box test folder (text renderings of
  the public EDGAR exhibits below), the Jev decisions through the TypeSafeAI
  connector, the extraction and search calls through OpenRouter, the
  deterministic cash runner, the counteroffer search on the worker Sprites,
  the Box watcher, the web app, and the export-time recheck that detects Box
  drift.
- **Synthetic or assumed**: the hand-checked $12,000 deposit ledger used as
  the arithmetic oracle (`fixtures/runner/synthetic-12k*.json`), the demo
  cash assumptions (opening cash, cash floor, monthly costs on the 15th), the
  October 1, 2026 escrow funding date (Section 3(b) says only "immediately
  upon execution"), and the typed-decision fixture cases used by the M1
  proof. The client reply letters used to test the reply loop
  (`fixtures/box/reply-v1`, `reply-v2`) are synthetic and labeled as such.
  The First Amendment payment due on execution of the merger
  agreement has no stated date and is left out of the cash model.
- **Runner policies**: payments due on a weekend are counted on the next
  business day (the contract itself says January 2, 2027), costs never move,
  and there is no holiday calendar.
- **Private, not in this repo**: the hand-maintained human review record
  (`reviews/retainer-review.json`) and the proof evidence written under
  `$CAVEAT_PRIVATE`.
- **Model reliability**: the free model is not always consistent. On
  2026-11-24 at 14:08 UTC (run `run-20261124-140809-1093`) its reason argued
  that the second amendment is an escrow release, but its answer field said
  `cash_on_fixed_date`, with a self-reported confidence of 0.97. Caveat
  blocked the run as `needs_review` because only an `escrow_release` answer
  is modeled; it does not detect a reason that contradicts its answer in
  general. Another run (16:50 UTC the same day) was blocked as a schema
  mismatch when the model returned "$25,000 per month" where a bare amount
  was required. The proof scripts retry a blocked run once, so a passing
  proof does not mean the model is reliable.
- **Self-reported confidence**: model confidence values are self-reported by
  the model, not calibrated — a `1.00` is the model's own claim and is shown
  as such.

## Reference runs

Two live runs on `main` (`83cb9df`) serve as the reference baselines. The
video is a motion rebuild of the review pages, using figures from these runs
and from the client-reply run `run-20261126-135456-888a`. Receipts, review
pages and drafts are kept in the owner's private evidence, not in this repo.

- **Twin Vee**: `run-20261126-194248-5921`. It uses the owner's
  `my-cash.csv` and the synthetic v2 client reply, which both workers mark
  safe. Its input and result digests match the earlier verified run
  `run-20261126-163526-4046`.
- **Aviat**: `run-20261126-194031-c7fb`. Both partial-month readings run
  under both scenarios on both workers, using the labeled demo cash.

## Limitations and next

- **No Aviat counteroffer search.** The counteroffer search does not yet
  cover monthly-fee contracts; shorter payment terms is the planned first
  lever.
- **Slow free model.** Extraction and search use a free OpenRouter model,
  which can be slow and sometimes stops a run for human review. Answers
  reused from earlier clean runs avoid most repeat calls.
- **No Box webhook.** The watcher polls Box every 60 s while the
  coordinator is awake, so it only sees uploads while the coordinator
  is running.
- **Read-only.** Caveat never writes to Box and never sends, signs or
  publishes anything; drafts export only after a human approves them.

## Requirements
- Node.js >=24.10 <25 (see `.nvmrc`), npm 11.6.1

## Commands
- `npm install` — install locked dependencies
- `npm run test` — vitest suite
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint
- `npm run build` — emit to `dist/`
- `npm run check` — all of the above
- `npm run fixture -- fixtures/runner/<name>.json` — run a cash-runner fixture and print the per-scenario summary and digests

## Proofs and deploy (operator machine, `sprite` CLI authenticated)

All evidence is written under `$CAVEAT_PRIVATE` (default
`~/caveat-private`), never into the repo.

- `scripts/m1/run-coord-proof.sh` — coordinator proof: reads a Box file
  through the connector and runs one typed OpenRouter decision.
- `scripts/m1/isolation-proof.sh` — worker isolation proof: two workers with
  no connector grants, checkpoint/restore on worker A.
- `scripts/m3/run-coord-m3.sh` — full pipeline on the coordinator: Box
  sources, sectionizer, typed decisions, flags, both cash readings, receipt +
  standalone review page. Needs `reviews/retainer-review.json` under
  `$CAVEAT_PRIVATE`.
- `scripts/m3/worker-replay.sh` — deterministic replay on both workers
  (bundle, overlay, checkpoint, restore, replay digest comparison).
- `scripts/m4/deploy.sh` — deploys `git archive HEAD` plus a REVISION file to
  the coordinator and (re)creates the `caveat` service. Refuses a dirty tree;
  needs the private review file.
- `scripts/m4/proof-a.sh` — release proof against the deployed service:
  signed-out checks, run → approve → export round-trip, Box-unavailable
  handling via connector access policy (with a restore trap), persistence
  across restart.
- `scripts/m4/proof-b.sh` — stale-detection proof: re-uploaded Box version
  blocks export of an approved run, redeploy migrates the schema, a new run
  supersedes the old.

Useful environment overrides: `CAVEAT_COORD_SPRITE`, `CAVEAT_WORKER_A`,
`CAVEAT_WORKER_B`, `CAVEAT_SERVICE`, `CAVEAT_PRIVATE`, `CAVEAT_BOX_FOLDER`,
`CAVEAT_OPERATIVE_FILE`, `CAVEAT_RUN_TIMEOUT_MS` (default 1200000),
`CAVEAT_SEARCH_TIMEOUT_MS` (default 240000, per search round),
`CAVEAT_WATCH_INTERVAL_MS` (default 60000, `0` disables the Box watcher),
`CAVEAT_WORKERS` (default
`caveat-wa=caveat-worker-a,caveat-wb=caveat-worker-b`: each worker Sprite
paired with the connector that reaches it),
`CAVEAT_RECHECK_TIMEOUT_MS` (default 30000), `CAVEAT_APPROVER` (required to
approve a run), `CAVEAT_DATA_DIR` (service database location).

## Source documents
The live evidence path reads text renderings of three public SEC EDGAR exhibits
(Twin Vee PowerCats Co. consulting agreement and its two amendments) from a
private Box test folder. The PDFs are not in this repository; the linked
exhibits are the authoritative copies. Caveat cites section numbers, not the
regenerated page numbers.

| Document | Official EDGAR exhibit |
|---|---|
| Consulting agreement (Feb 25, 2026) | [Exhibit 10.1](https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm) |
| First amendment (July 11, 2026) | [Exhibit 10.1, appended amendment](https://www.sec.gov/Archives/edgar/data/1855509/000173112226000931/e7774_ex10-1.htm) |
| Second amendment (Oct 1, 2026) | [Exhibit 10.1](https://www.sec.gov/Archives/edgar/data/1855509/000173112226001331/e8000_ex10-1.htm) |

Source: U.S. Securities and Exchange Commission, EDGAR. Any opening cash,
costs or modeled extensions are demo assumptions, not facts about the parties.
The cash-runner arithmetic is checked against a fixed synthetic ledger.

## Environment
- `CAVEAT_DECISION_MODEL` — OpenRouter model id for extraction and the
  counteroffer search (default `nvidia/nemotron-3.5-super-vl:free`).
- When a TypeSafeAI connector is visible to the coordinator, Jev makes the
  typed decisions and each receipt records provider `typesafe`, model
  `jev-1.14.0`, the probabilities and token usage. Without one, the
  release-timing decision falls back to the OpenRouter model, the letter
  gate is skipped, and the receipt says so.
- Live receipt: run `run-20261126-152146-799a` — Jev chose `escrow_release`
  (confidence 0.96), cited Second Amendment §3(b)(i) (confidence 1.00), and
  passed the client letter gate (p = 0.92); the client's counter tested safe
  on both workers. Earlier runs where the first wording of the citation
  question split 70/30 between two true clauses were sent to human review
  and kept as evidence.

**Not legal advice. Drafts are never sent.**
