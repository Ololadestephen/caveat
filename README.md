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
