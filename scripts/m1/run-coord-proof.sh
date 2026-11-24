#!/usr/bin/env bash
# Push the coord-proof to the coordinator Sprite and run it there.
# Prints one sanitized JSON object and saves it to ~/caveat-private/m1/.
set -euo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
REMOTE_DIR="/home/sprite/caveat-m1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="${CAVEAT_PRIVATE:-$HOME/caveat-private}/m1"

sprite exec --no-stdin -s "$SPRITE" -- rm -rf "$REMOTE_DIR"
for DIR in src scripts fixtures; do
  sprite file push -p -s "$SPRITE" -r "$REPO_ROOT/$DIR" "$REMOTE_DIR/$DIR" >/dev/null
done

ENV_VARS=""
for VAR in CAVEAT_BOX_FOLDER CAVEAT_GEMINI_MODEL CAVEAT_PROOF_CASE; do
  if [ -n "${!VAR:-}" ]; then
    ENV_VARS="${ENV_VARS:+$ENV_VARS,}$VAR=${!VAR}"
  fi
done

mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/coord-$(date +%Y%m%dT%H%M%S).json"

if [ -n "$ENV_VARS" ]; then
  sprite exec --no-stdin -s "$SPRITE" --env "$ENV_VARS" -- node "$REMOTE_DIR/scripts/m1/coord-proof.ts" | tee "$OUT"
else
  sprite exec --no-stdin -s "$SPRITE" -- node "$REMOTE_DIR/scripts/m1/coord-proof.ts" | tee "$OUT"
fi
