#!/usr/bin/env bash
# Push the coord-proof to the coordinator Sprite and run it there.
# Prints one sanitized JSON object and saves it to ~/caveat-private/m1/.
set -euo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
REMOTE_DIR="/home/sprite/caveat-m1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="${CAVEAT_PRIVATE:-$HOME/caveat-private}/m1"

sprite exec --no-stdin -s "$SPRITE" -- rm -rf "$REMOTE_DIR"
sprite exec --no-stdin -s "$SPRITE" -- mkdir -p "$REMOTE_DIR"
sprite file push -s "$SPRITE" -r \
  "$REPO_ROOT/src" \
  "$REPO_ROOT/scripts" \
  "$REPO_ROOT/fixtures" \
  "$REMOTE_DIR/"

ENV_VARS=""
if [ -n "${CAVEAT_BOX_FOLDER:-}" ]; then ENV_VARS="CAVEAT_BOX_FOLDER=$CAVEAT_BOX_FOLDER"; fi
if [ -n "${CAVEAT_OLLAMA_MODEL:-}" ]; then
  ENV_VARS="${ENV_VARS:+$ENV_VARS,}CAVEAT_OLLAMA_MODEL=$CAVEAT_OLLAMA_MODEL"
fi

mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/coord-$(date +%Y%m%dT%H%M%S).json"

if [ -n "$ENV_VARS" ]; then
  sprite exec --no-stdin -s "$SPRITE" --env "$ENV_VARS" -- node "$REMOTE_DIR/scripts/m1/coord-proof.ts" | tee "$OUT"
else
  sprite exec --no-stdin -s "$SPRITE" -- node "$REMOTE_DIR/scripts/m1/coord-proof.ts" | tee "$OUT"
fi
