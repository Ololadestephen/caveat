#!/usr/bin/env bash
# Milestone-3 coordinator run: push the pipeline to caveat-coord, run it there,
# and pull the receipt + review page into ~/caveat-private/m3/.
# Exits non-zero when the run is blocked (coord-run exits 2) or errors (1).
set -uo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
REMOTE_DIR="/home/sprite/caveat-m3"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIVATE="${CAVEAT_PRIVATE:-$HOME/caveat-private}"
REVIEWS="$PRIVATE/reviews"
EVIDENCE_DIR="$PRIVATE/m3"
RUN_ID="${CAVEAT_RUN_ID:-m3-$(date +%Y%m%dT%H%M%S)}"

if [ ! -f "$REVIEWS/retainer-review.json" ]; then
  echo "missing private review file: $REVIEWS/retainer-review.json" >&2
  exit 1
fi

sprite exec --no-stdin -s "$SPRITE" -- rm -rf "$REMOTE_DIR" "/home/sprite/caveat-runs/$RUN_ID"
for DIR in src scripts fixtures; do
  sprite file push -p -s "$SPRITE" -r "$REPO_ROOT/$DIR" "$REMOTE_DIR/$DIR" >/dev/null
done
for F in package.json package-lock.json; do
  sprite file push -p -s "$SPRITE" "$REPO_ROOT/$F" "$REMOTE_DIR/$F" >/dev/null
done
sprite file push -p -s "$SPRITE" -r "$REVIEWS" "$REMOTE_DIR/reviews" >/dev/null

# The coordinator needs pdfjs-dist for PDF text extraction.
if ! sprite exec --no-stdin -s "$SPRITE" -- sh -c "cd '$REMOTE_DIR' && npm ci --omit=dev --no-audit --no-fund" >/dev/null; then
  echo "npm ci failed on the coordinator (registry unreachable?); push node_modules and retry" >&2
  exit 1
fi

ENV_VARS="CAVEAT_RUN_ID=$RUN_ID"
for VAR in CAVEAT_BOX_FOLDER CAVEAT_DECISION_MODEL CAVEAT_REVIEWS_DIR CAVEAT_RUN_DIR; do
  if [ -n "${!VAR:-}" ]; then
    ENV_VARS="${ENV_VARS},$VAR=${!VAR}"
  fi
done

mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/coord-$RUN_ID.json"

set +e
sprite exec --no-stdin -s "$SPRITE" --env "$ENV_VARS" \
  -- sh -c "cd '$REMOTE_DIR' && node scripts/m3/coord-run.ts" | tee "$OUT"
RC=${PIPESTATUS[0]}
set -e

sprite file pull -p -r -s "$SPRITE" "/home/sprite/caveat-runs/$RUN_ID" \
  "$EVIDENCE_DIR/$RUN_ID" >/dev/null 2>&1 || echo "warning: could not pull run outputs" >&2

exit "$RC"
