#!/usr/bin/env bash
# Milestone-3 worker replay proof, run from the operator Mac.
#  - identical candidate-less bundle on both workers (sha256 checked vs local)
#  - each worker gets a different overlay (wa: deposit_1000, wb: deposit_2000)
#    and each overlay is absent on the other worker
#  - merged bundle+overlay runs on each worker; resultDigest must equal a local
#    run of the same merged input
#  - checkpoint wa -> restore -> overlay gone, bundle unchanged
#  - re-push the same overlay, rerun -> identical resultDigest
# Writes a sanitized summary to ~/caveat-private/m3/workers-<ts>.json and exits
# non-zero on any failure. Leaves only checkpoint v1 on each worker.
set -uo pipefail

SPRITE="${SPRITE_CLI:-$HOME/.local/bin/sprite}"
WORKER_A="${CAVEAT_WORKER_A:-caveat-wa}"
WORKER_B="${CAVEAT_WORKER_B:-caveat-wb}"
REMOTE_DIR="/home/sprite/caveat-m3-worker"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="${CAVEAT_PRIVATE:-$HOME/caveat-private}/m3"
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$EVIDENCE_DIR/workers-$STAMP.json"
FIXTURE="$REPO_ROOT/fixtures/runner/synthetic-12k.json"
WORK_TMP="$(mktemp -d)"

CHECK_NAMES=()
CHECK_RESULTS=()
check() { CHECK_NAMES+=("$1"); CHECK_RESULTS+=("$2"); }

ms() { printf '%s000' "$(date +%s)"; }
remote() { "$SPRITE" exec --no-stdin -s "$1" -- sh -c "$2"; }
remote_rc() { "$SPRITE" exec --no-stdin -s "$1" -- sh -c "$2" >/dev/null 2>&1; }

mkdir -p "$EVIDENCE_DIR"

# --- build bundle + overlays locally ----------------------------------------
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const f = JSON.parse(readFileSync(process.argv[1], "utf8"));
const { candidates, ...bundle } = f;
writeFileSync(process.argv[2] + "/bundle.json", JSON.stringify(bundle));
for (const [name, id] of [["wa-overlay", "deposit_1000"], ["wb-overlay", "deposit_2000"]]) {
  writeFileSync(
    process.argv[2] + `/${name}.json`,
    JSON.stringify({ candidates: candidates.filter((c) => c.id === id) }),
  );
}
' "$FIXTURE" "$WORK_TMP" || { echo "could not build bundle/overlays" >&2; exit 1; }

LOCAL_SHA=$(shasum -a 256 "$WORK_TMP/bundle.json" | awk '{print $1}')

# Local reference runs for the merged inputs.
LOCAL_DIGEST_A=$(cd "$REPO_ROOT" && node scripts/m3/worker-run.ts "$WORK_TMP/bundle.json" "$WORK_TMP/wa-overlay.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).resultDigest))')
LOCAL_DIGEST_B=$(cd "$REPO_ROOT" && node scripts/m3/worker-run.ts "$WORK_TMP/bundle.json" "$WORK_TMP/wb-overlay.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).resultDigest))')

# --- push code + bundle to both workers -------------------------------------
for W in "$WORKER_A" "$WORKER_B"; do
  remote "$W" "rm -rf $REMOTE_DIR" >/dev/null
  "$SPRITE" file push -p -s "$W" -r "$REPO_ROOT/src" "$REMOTE_DIR/src" >/dev/null
  "$SPRITE" file push -p -s "$W" -r "$REPO_ROOT/scripts" "$REMOTE_DIR/scripts" >/dev/null
  "$SPRITE" file push -p -s "$W" "$WORK_TMP/bundle.json" "$REMOTE_DIR/bundle.json" >/dev/null
  RSHA=$(remote "$W" "sha256sum $REMOTE_DIR/bundle.json" | awk '{print $1}')
  check "bundle_sha256_match_$W" "$([ "$RSHA" = "$LOCAL_SHA" ] && echo pass || echo fail)"
done

# --- checkpoint both workers --------------------------------------------------
CREATE_T0=$(ms)
CREATE_A_OUT=$("$SPRITE" checkpoint create -s "$WORKER_A" --comment "caveat-m3 replay $STAMP" 2>&1)
VER_A=$(printf '%s\n' "$CREATE_A_OUT" | grep -oE 'v[0-9]+' | head -1)
CREATE_A_MS=$(( $(ms) - CREATE_T0 ))
CREATE_T0=$(ms)
CREATE_B_OUT=$("$SPRITE" checkpoint create -s "$WORKER_B" --comment "caveat-m3 replay $STAMP" 2>&1)
VER_B=$(printf '%s\n' "$CREATE_B_OUT" | grep -oE 'v[0-9]+' | head -1)
CREATE_B_MS=$(( $(ms) - CREATE_T0 ))
check "checkpoint_created_$WORKER_A" "$([ -n "$VER_A" ] && echo pass || echo fail)"
check "checkpoint_created_$WORKER_B" "$([ -n "$VER_B" ] && echo pass || echo fail)"

# --- overlays ------------------------------------------------------------------
"$SPRITE" file push -p -s "$WORKER_A" "$WORK_TMP/wa-overlay.json" "$REMOTE_DIR/wa-overlay.json" >/dev/null
"$SPRITE" file push -p -s "$WORKER_B" "$WORK_TMP/wb-overlay.json" "$REMOTE_DIR/wb-overlay.json" >/dev/null

if remote_rc "$WORKER_B" "test -e $REMOTE_DIR/wa-overlay.json"; then
  check "wa_overlay_absent_on_$WORKER_B" fail
else
  check "wa_overlay_absent_on_$WORKER_B" pass
fi
if remote_rc "$WORKER_A" "test -e $REMOTE_DIR/wb-overlay.json"; then
  check "wb_overlay_absent_on_$WORKER_A" fail
else
  check "wb_overlay_absent_on_$WORKER_A" pass
fi

# --- run on each worker ---------------------------------------------------------
RUN_OUT_A=$(remote "$WORKER_A" "cd $REMOTE_DIR && node scripts/m3/worker-run.ts bundle.json wa-overlay.json" 2>/dev/null)
DIGEST_A=$(printf '%s' "$RUN_OUT_A" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).resultDigest)}catch{console.log("")}})')
RUN_OUT_B=$(remote "$WORKER_B" "cd $REMOTE_DIR && node scripts/m3/worker-run.ts bundle.json wb-overlay.json" 2>/dev/null)
DIGEST_B=$(printf '%s' "$RUN_OUT_B" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).resultDigest)}catch{console.log("")}})')

check "digest_match_$WORKER_A" "$([ -n "$DIGEST_A" ] && [ "$DIGEST_A" = "$LOCAL_DIGEST_A" ] && echo pass || echo fail)"
check "digest_match_$WORKER_B" "$([ -n "$DIGEST_B" ] && [ "$DIGEST_B" = "$LOCAL_DIGEST_B" ] && echo pass || echo fail)"

# --- restore wa, verify overlay gone, replay ------------------------------------
RESTORE_T0=$(ms)
"$SPRITE" restore -s "$WORKER_A" "$VER_A" >/dev/null 2>&1
READY=fail
for _ in $(seq 1 60); do
  if remote_rc "$WORKER_A" "true"; then READY=pass; break; fi
  sleep 5
done
RESTORE_MS=$(( $(ms) - RESTORE_T0 ))
check "restore_ready_within_300s" "$READY"

if remote_rc "$WORKER_A" "test -e $REMOTE_DIR/wa-overlay.json"; then
  check "overlay_gone_after_restore_$WORKER_A" fail
else
  check "overlay_gone_after_restore_$WORKER_A" pass
fi
RSHA=$(remote "$WORKER_A" "sha256sum $REMOTE_DIR/bundle.json" | awk '{print $1}')
check "bundle_unchanged_after_restore_$WORKER_A" "$([ "$RSHA" = "$LOCAL_SHA" ] && echo pass || echo fail)"

"$SPRITE" file push -p -s "$WORKER_A" "$WORK_TMP/wa-overlay.json" "$REMOTE_DIR/wa-overlay.json" >/dev/null
REPLAY_OUT=$(remote "$WORKER_A" "cd $REMOTE_DIR && node scripts/m3/worker-run.ts bundle.json wa-overlay.json" 2>/dev/null)
DIGEST_REPLAY=$(printf '%s' "$REPLAY_OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).resultDigest)}catch{console.log("")}})')
check "replay_same_digest_$WORKER_A" "$([ -n "$DIGEST_REPLAY" ] && [ "$DIGEST_REPLAY" = "$LOCAL_DIGEST_A" ] && echo pass || echo fail)"

# --- checkpoint cleanup: leave only v1 on each worker ----------------------------
list_versions() {
  "$SPRITE" checkpoint list -s "$1" 2>/dev/null | grep -oE 'v[0-9]+' | sort -uV
}
REMAIN_A=""; REMAIN_B=""
for W in "$WORKER_A" "$WORKER_B"; do
  for V in $(list_versions "$W"); do
    [ "$V" = "v1" ] || "$SPRITE" checkpoint delete -s "$W" "$V" >/dev/null 2>&1
  done
  LEFT=$(list_versions "$W" | tr '\n' ',' | sed 's/,$//')
  eval "REMAIN_${W#caveat-}=$LEFT"
  check "only_v1_remains_$W" "$([ "$LEFT" = "v1" ] && echo pass || echo fail)"
done

# --- verdict + summary -----------------------------------------------------------
ALL_PASS=1
for R in "${CHECK_RESULTS[@]}"; do
  [ "$R" != fail ] || ALL_PASS=0
done

CHECKS_JSON=""
for i in "${!CHECK_NAMES[@]}"; do
  case "${CHECK_RESULTS[$i]}" in
    pass) V=true ;;
    *) V=false ;;
  esac
  CHECKS_JSON+="\"${CHECK_NAMES[$i]}\":$V,"
done
CHECKS_JSON="${CHECKS_JSON%,}"

cat > "$OUT" <<JSON
{
  "proof": "caveat-m3-worker-replay",
  "ranAt": "$STAMP",
  "workers": ["$WORKER_A", "$WORKER_B"],
  "bundleSha256": "$LOCAL_SHA",
  "overlays": {"${WORKER_A#caveat-}": "deposit_1000", "${WORKER_B#caveat-}": "deposit_2000"},
  "resultDigests": {"${WORKER_A#caveat-}": "$DIGEST_A", "${WORKER_B#caveat-}": "$DIGEST_B", "${WORKER_A#caveat-}_replay": "$DIGEST_REPLAY"},
  "localReferenceDigests": {"${WORKER_A#caveat-}": "$LOCAL_DIGEST_A", "${WORKER_B#caveat-}": "$LOCAL_DIGEST_B"},
  "checks": {$CHECKS_JSON},
  "checkpoints": {"versions": {"${WORKER_A#caveat-}": "${VER_A:-none}", "${WORKER_B#caveat-}": "${VER_B:-none}"}, "remaining": {"${WORKER_A#caveat-}": "${REMAIN_wa:-unknown}", "${WORKER_B#caveat-}": "${REMAIN_wb:-unknown}"}},
  "timingsMs": {"checkpointCreateA": $CREATE_A_MS, "checkpointCreateB": $CREATE_B_MS, "restoreUntilReady": $RESTORE_MS},
  "result": "$([ "$ALL_PASS" = 0 ] && echo fail || echo pass)"
}
JSON

cat "$OUT"
rm -rf "$WORK_TMP"
[ "$ALL_PASS" = 1 ] || exit 1
