# AGENTS.md

## Mission
Build Caveat: compare one quote and two counteroffers under identical cash-flow
stress cases, using Box evidence, typed Ollama decisions (Jev may be added
later), deterministic cash math, and isolated Fly Sprites. Keep one end-to-end
flow working. Export drafts only.

## Working rules
- Write the implementation plan and demo script before coding. Prove real Box
  and Ollama calls from a Sprite, two-worker isolation, and in-place
  checkpoint restore as the first implementation milestone. Never claim cloning.
- Keep cash math deterministic in integer cents. Only interpreted, validated
  evidence may enter the runner. Show citations and route unclear terms to
  human review. Verify current evidence and the exact approved hash on export.
- Keep speculative workers free of provider secrets and external write authority.
  Use synthetic fixtures only. Do not implement automatic sending, buying,
  signing, or committing anything to an external service.
- Commit after every working change with a plain message, no AI co-author
  lines, and explicit staged paths. Run relevant tests and inspect the diff
  first. No remote creation, push, public deployment, post or submission
  without the owner's approval.
- Never commit notes, private files, real contracts, credentials, raw provider
  responses, local state, recordings or Desloppify output. Keep them outside the
  repo; check the staged list before every commit.
- Run Desloppify on the real source, review `next`, fix in-scope results,
  rescan after cleanup and run the full checks. Report any remaining work.
- At milestones report the commit SHA, observed proof, check results, and
  blockers. Label mocked, untested or synthetic behavior accurately.
