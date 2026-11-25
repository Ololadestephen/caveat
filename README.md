# Caveat

Caveat reads a consultant's contract documents from Box, asks a model typed
questions about the payment terms, and stress-tests the answers against a
deterministic cash-flow model before anyone signs. Every run ends in a
receipt that a human must approve; the export is a draft counteroffer note —
never sent, never legal advice.

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
  changes, runs each one on the worker Sprites, feeds the runner's results
  back and repeats for up to four rounds, keeping the smallest tested change
  that holds cash at or above the floor in every scenario.
- **Stale approval.** Approvals pin the exact Box version of every source
  file. The coordinator watches the Box folder; when the amendment is
  re-uploaded as a new Box version (same bytes), the old approval is marked
  `stale`, its export is refused, and a fresh draft goes into review.

## Architecture

- **Coordinator Sprite** (`caveat-coord`): runs the `caveat` HTTP service
  (`src/server/`, `node:http`, no framework, no added dependencies). Runs
  live in a `node:sqlite` database (`src/store/db.ts`) — receipt and draft
  fields are immutable once written (enforced by triggers), status flows
  `running → reviewable → approved`, with `stale`, `needs_review`, `failed`
  and `superseded` states kept visible. A run interrupted mid-flight becomes
  a `failed` row on restart, not a silent disappearance.
- **Connectors**: the only route to Box and OpenRouter is the coordinator's
  Sprite connectors, scoped by an access policy (the proof folder's
  `/2.0/folders/*` and `/2.0/files/*` endpoints, and `/v1/chat/completions`
  for OpenRouter). The Box and OpenRouter keys are held by the connectors
  and never reach this repo, the operator's machine or any Sprite. The
  operator's machine holds only its `sprite` CLI login, which the proof
  scripts use through `sprite exec` and `sprite proxy`; the coordinator
  holds no org token.
- **Counteroffer search** (`src/search/`): the model proposes up to three
  candidates per round as strict JSON, using four levers that move money
  already in the deal earlier (a cash deposit at signing, an earlier escrow
  release, a monthly split of that release, or shorter payment terms). The
  coordinator compiles each candidate into payment rules, runs it on both
  workers in parallel under both retainer readings and both extension cases,
  and sends the runner's results back. The search stops when the model says
  it is done or after four rounds. The model never supplies a balance: the
  runner is the only source of numbers, and "smallest" means the fewest
  dollars paid earlier than the signed terms. Candidates that fail
  validation or that the runner rejects are listed for human review. Every
  round (candidates, results and the model's note on why it moved on) is on
  the review page.
- **Box watcher** (`src/watch/`): while the coordinator is awake it checks
  the Box folder's file versions every 60 s. A new version marks approved
  and reviewable runs on the old version `stale` and starts a new run that
  re-asks the model only when the text it would see has changed. Unchanged
  answers are carried forward with a pointer to the run they came from, and
  the deterministic steps always rerun. Sprites pause when idle and the
  watcher pauses with them; the next request wakes it and it checks again.
  It never uploads to Box or sends anything.
- **Worker Sprites** (`caveat-wa`, `caveat-wb`): hold no Box/OpenRouter
  grants at all. The coordinator reaches them through one Custom API
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
  the public EDGAR exhibits below), the model calls through OpenRouter, the
  deterministic cash runner, the counteroffer search on the worker Sprites,
  the Box watcher, the web app, and the export-time recheck that detects Box
  drift.
- **Synthetic or assumed**: the hand-checked $12,000 deposit ledger used as
  the arithmetic oracle (`fixtures/runner/synthetic-12k*.json`), the demo
  cash assumptions (opening cash, cash floor, monthly costs on the 15th), the
  October 1, 2026 escrow funding date (Section 3(b) says only "immediately
  upon execution"), and the typed-decision fixture cases used by the M1
  proof. The First Amendment payment due on execution of the merger
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
`CAVEAT_OPERATIVE_FILE`, `CAVEAT_RUN_TIMEOUT_MS` (default 600000),
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
- `CAVEAT_DECISION_MODEL` — model id for every typed call, including the
  counteroffer search (default `nvidia/nemotron-3.5-super-vl:free`).
  Jev (`typesafe/jev-router`) is configurable, untested: setting this
  variable changes only the model id in the request, but no run has used
  Jev, and it is priced on OpenRouter rather than free.

**Not legal advice. Drafts are never sent.**
