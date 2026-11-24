# Caveat

Stress-test a freelancer's payment terms before signing. Compare one quote and
two counteroffers under identical cash-flow scenarios, grounded in Box evidence
and typed model decisions, with isolated Fly Sprite workers.

## Requirements
- Node.js >=24.10 <25 (see `.nvmrc`), npm 11.6.1

## Commands
- `npm install` — install locked dependencies
- `npm run test` — vitest suite
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint
- `npm run build` — emit to `dist/`
- `npm run check` — all of the above

## Milestone-1 proofs (operator machine, sprite CLI authenticated)
- `./scripts/m1/run-coord-proof.sh` — push + run the coordinator evidence proof
- `./scripts/m1/isolation-proof.sh` — two-worker isolation + checkpoint/restore proof

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
