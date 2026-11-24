#!/usr/bin/env bash
# Deploy the committed tree to caveat-coord as the `caveat` HTTP service.
# Refuses to deploy a dirty tree: the remote tree is exactly `git archive HEAD`
# plus a REVISION file, so the footer always shows the deployed commit.
set -euo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
APP_DIR="/home/sprite/caveat-app"
DATA_DIR="/home/sprite/caveat-data"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIVATE="${CAVEAT_PRIVATE:-$HOME/caveat-private}"
SERVICE="${CAVEAT_SERVICE:-caveat}"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "refusing to deploy: working tree is dirty" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

if [ ! -f "$PRIVATE/reviews/retainer-review.json" ]; then
  echo "missing private review file: $PRIVATE/reviews/retainer-review.json" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$STAGE"
git -C "$REPO_ROOT" rev-parse HEAD >"$STAGE/REVISION"

sprite exec --no-stdin -s "$SPRITE" -- rm -rf "$APP_DIR"
sprite file push -p -s "$SPRITE" -r "$STAGE" "$APP_DIR" >/dev/null

# Dependencies: the sprite's npm v12 rejects our npm-11 lockfile, so install
# with npm 11 via npx. If the registry is unreachable, fall back to pushing
# the local pdfjs-dist package (it has no runtime dependencies).
if ! sprite exec --no-stdin -s "$SPRITE" -- \
  sh -c "cd '$APP_DIR' && npx -y npm@11.6.1 ci --omit=dev --no-audit --no-fund" >/dev/null 2>&1; then
  echo "npx npm@11 ci failed on the coordinator; pushing node_modules/pdfjs-dist instead" >&2
  PDFJS_STAGE="$STAGE/pdfjs-dist"
  mkdir -p "$PDFJS_STAGE"
  cp "$REPO_ROOT/node_modules/pdfjs-dist/package.json" "$PDFJS_STAGE/"
  cp -R "$REPO_ROOT/node_modules/pdfjs-dist/legacy" "$PDFJS_STAGE/"
  find "$PDFJS_STAGE" -name '*.map' -delete
  sprite file push -p -s "$SPRITE" -r "$PDFJS_STAGE" \
    "$APP_DIR/node_modules/pdfjs-dist" >/dev/null
fi

sprite file push -p -s "$SPRITE" "$PRIVATE/reviews/retainer-review.json" \
  "$DATA_DIR/reviews/retainer-review.json" >/dev/null

NODE_BIN="$(sprite exec --no-stdin -s "$SPRITE" -- sh -c 'command -v node' | tr -d '[:space:]')"
if [ -z "$NODE_BIN" ]; then
  echo "could not find node on $SPRITE" >&2
  exit 1
fi

if sprite exec --no-stdin -s "$SPRITE" -- sprite-env services get "$SERVICE" >/dev/null 2>&1; then
  sprite exec --no-stdin -s "$SPRITE" -- sprite-env services delete "$SERVICE" >/dev/null
fi
sprite exec --no-stdin -s "$SPRITE" -- sprite-env services create "$SERVICE" \
  --cmd "$NODE_BIN" \
  --args "src/server/main.ts" \
  --dir "$APP_DIR" \
  --env "CAVEAT_DATA_DIR=$DATA_DIR,CAVEAT_APPROVER=Ololade Stephen,CAVEAT_DECISION_MODEL=nvidia/nemotron-3.5-super-vl:free" \
  --http-port 8080 --no-stream

echo "deployed $(cat "$STAGE/REVISION") to $SPRITE as service $SERVICE"
