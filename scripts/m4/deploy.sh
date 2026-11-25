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

# Worker code: the runner batch entry point plus its src/ dependencies. The
# {"type":"module"} package.json makes the sprite's node treat the pushed .ts
# files as ESM. Workers' checkpoints are never touched.
WORKER_STAGE="$STAGE/caveat-worker"
mkdir -p "$WORKER_STAGE"
cp -R "$STAGE/src" "$WORKER_STAGE/src"
printf '{"type":"module"}\n' >"$WORKER_STAGE/package.json"
node -e '
  const fixture = require(process.argv[1]);
  process.stdout.write(JSON.stringify({ jobs: [{ jobId: "smoke", input: fixture }] }));
' "$REPO_ROOT/fixtures/runner/synthetic-12k.json" >"$STAGE/smoke-input.json"

# CAVEAT_WORKERS is the pipeline's worker=connector format; the sprite name is
# the part before "=". A bare name is used as-is.
for ENTRY in $(echo "${CAVEAT_WORKERS:-caveat-wa,caveat-wb}" | tr ',' ' '); do
  WORKER="${ENTRY%%=*}"
  sprite exec --no-stdin -s "$WORKER" -- rm -rf /home/sprite/caveat-worker
  sprite file push -p -s "$WORKER" -r "$WORKER_STAGE" /home/sprite/caveat-worker >/dev/null

  # The worker service: a tiny HTTP endpoint the coordinator reaches through
  # the worker's own Custom API connector. URL auth stays `sprite`.
  if sprite exec --no-stdin -s "$WORKER" -- sprite-env services get caveat-worker >/dev/null 2>&1; then
    sprite exec --no-stdin -s "$WORKER" -- sprite-env services delete caveat-worker >/dev/null
  fi
  sprite exec --no-stdin -s "$WORKER" -- sprite-env services create caveat-worker \
    --cmd "/.sprite/bin/node" \
    --args "src/worker/server.ts" \
    --dir "/home/sprite/caveat-worker" \
    --http-port 8080 --no-stream

  READY=""
  for _ in $(seq 1 30); do
    if sprite exec --no-stdin -s "$WORKER" -- sh -c 'curl -sf localhost:8080/healthz' >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done
  if [ -z "$READY" ]; then
    echo "worker $WORKER: service caveat-worker never answered /healthz" >&2
    exit 1
  fi

  SMOKE_OUT="$(sprite exec -s "$WORKER" -- \
    sh -c 'curl -s -X POST -H "content-type: application/json" --data-binary @- localhost:8080/run-batch' \
    <"$STAGE/smoke-input.json")"
  if ! printf '%s' "$SMOKE_OUT" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try {
        const batch = JSON.parse(raw.trim());
        const first = batch.results?.[0];
        if (first?.ok !== true) process.exit(1);
      } catch {
        process.exit(1);
      }
    });
  '; then
    echo "worker $WORKER smoke test failed:" >&2
    echo "$SMOKE_OUT" >&2
    exit 1
  fi
  echo "worker $WORKER: code pushed, service caveat-worker up, smoke test ok"
done

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
  --env "CAVEAT_DATA_DIR=$DATA_DIR,CAVEAT_APPROVER=Ololade Stephen,CAVEAT_DECISION_MODEL=nvidia/nemotron-3.5-super-vl:free,CAVEAT_WATCH_INTERVAL_MS=${CAVEAT_WATCH_INTERVAL_MS:-60000}" \
  --http-port 8080 --no-stream

echo "deployed $(cat "$STAGE/REVISION") to $SPRITE as service $SERVICE"
