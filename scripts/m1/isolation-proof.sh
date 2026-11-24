#!/usr/bin/env bash
# Milestone-1 isolation proof, run from the operator Mac with the sprite CLI.
# (a) identical bundle sha256 on both workers
# (b) a marker written on A is absent on B
# (c) workers are denied the connector gateways (expected HTTP 403)
# (d) checkpoint A -> mutate -> restore -> original content back, post-marker
#     gone, pre-marker kept, B untouched
# Writes a sanitized JSON summary to ~/caveat-private/m1/isolation-<ts>.json
# and exits non-zero if any check fails.
set -uo pipefail

SPRITE="${SPRITE_CLI:-$HOME/.local/bin/sprite}"
WORKER_A="${CAVEAT_WORKER_A:-caveat-wa}"
WORKER_B="${CAVEAT_WORKER_B:-caveat-wb}"
COORD="${CAVEAT_COORD_SPRITE:-caveat-coord}"
REMOTE_DIR="/home/sprite/caveat-m1"
BUNDLE="fixtures/m1/bundle.json"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR="${CAVEAT_PRIVATE:-$HOME/caveat-private}/m1"
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="$EVIDENCE_DIR/isolation-$STAMP.json"

CHECK_NAMES=()
CHECK_RESULTS=()
check() { CHECK_NAMES+=("$1"); CHECK_RESULTS+=("$2"); }

ms() { printf '%s000' "$(date +%s)"; }

remote() { "$SPRITE" exec --no-stdin -s "$1" -- sh -c "$2"; }
remote_rc() { "$SPRITE" exec --no-stdin -s "$1" -- sh -c "$2" >/dev/null 2>&1; }

remote_sha() { remote "$1" "sha256sum $REMOTE_DIR/$2" | awk '{print $1}'; }

mkdir -p "$EVIDENCE_DIR"

LOCAL_SHA=$(shasum -a 256 "$REPO_ROOT/$BUNDLE" | awk '{print $1}')

# --- (a) identical bundle on both workers -----------------------------------
for W in "$WORKER_A" "$WORKER_B"; do
  "$SPRITE" file push -p -s "$W" "$REPO_ROOT/$BUNDLE" "$REMOTE_DIR/bundle.json" >/dev/null
  RSHA="$(remote_sha "$W" bundle.json)"
  check "bundle_sha256_match_$W" "$([ "$RSHA" = "$LOCAL_SHA" ] && echo pass || echo fail)"
done

# --- (b) marker on A absent from B ------------------------------------------
MARKER="marker-$STAMP-$$"
remote "$WORKER_A" "echo caveat-m1 > $REMOTE_DIR/$MARKER" >/dev/null
if remote_rc "$WORKER_A" "test -e $REMOTE_DIR/$MARKER"; then
  check "marker_written_on_$WORKER_A" pass
else
  check "marker_written_on_$WORKER_A" fail
fi
if remote_rc "$WORKER_B" "test -e $REMOTE_DIR/$MARKER"; then
  check "marker_absent_on_$WORKER_B" fail
else
  check "marker_absent_on_$WORKER_B" pass
fi

# --- (c) workers denied the connector gateways ------------------------------
LIST_JSON="$(remote "$COORD" "curl -s https://api.sprites.dev/v1/gateway/list")"
GW_OF() {
  printf '%s' "$LIST_JSON" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j=JSON.parse(d);
      const c=(j.connections||[]).find(x=>x.provider===process.argv[1]);
      console.log(c?c.gateway_base_url:"");
    });' "$1" 2>/dev/null
}
BOX_GW="$(GW_OF box)"
GEMINI_GW="$(GW_OF gemini)"

for W in "$WORKER_A" "$WORKER_B"; do
  # /v1/gateway/list is scoped to the calling sprite: a worker must not see the
  # restricted "box" connection in its own list.
  LISTED=$(remote "$W" "curl -s --max-time 15 https://api.sprites.dev/v1/gateway/list" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log((j.connections||[]).map(x=>x.provider).join(","))}catch{console.log("")}})')
  eval "LISTED_PROVIDERS_${W#caveat-}=$LISTED"
  case ",$LISTED," in
    *,box,*) check "box_not_listed_on_$W" fail ;;
    *) check "box_not_listed_on_$W" pass ;;
  esac

  if [ -n "$BOX_GW" ]; then
    CODE=$(remote "$W" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 '$BOX_GW/2.0/folders/0/items'" || echo "000")
    eval "BOX_CODE_${W#caveat-}=$CODE"
    check "box_gateway_denied_$W" "$([ "$CODE" = 403 ] && echo pass || echo fail)"
  else
    eval "BOX_CODE_${W#caveat-}=not_configured"
    check "box_gateway_denied_$W" fail
  fi

  if [ -n "$GEMINI_GW" ]; then
    CODE=$(remote "$W" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST '$GEMINI_GW/v1beta/models/gemini-flash-latest:generateContent' -H 'Content-Type: application/json' -d '{\"contents\":[{\"parts\":[{\"text\":\"hi\"}]}]}'" || echo "000")
    eval "GEMINI_CODE_${W#caveat-}=$CODE"
    check "gemini_gateway_denied_$W" "$([ "$CODE" = 403 ] && echo pass || echo fail)"
  else
    eval "GEMINI_CODE_${W#caveat-}=not_configured"
    check "gemini_gateway_denied_$W" skipped_not_configured
  fi
done

# --- (d) checkpoint, mutate, restore ----------------------------------------
CREATE_T0=$(ms)
CREATE_OUT="$("$SPRITE" checkpoint create -s "$WORKER_A" --comment "caveat-m1 isolation proof $STAMP")"
VER="$(printf '%s\n' "$CREATE_OUT" | grep -oE 'v[0-9]+' | head -1)"
CREATE_T1=$(ms)
CHECKPOINT_CREATE_MS=$((CREATE_T1 - CREATE_T0))

remote "$WORKER_A" "echo tampered >> $REMOTE_DIR/bundle.json && echo post-checkpoint > $REMOTE_DIR/post-$MARKER" >/dev/null

RESTORE_T0=$(ms)
"$SPRITE" restore -s "$WORKER_A" "$VER" >/dev/null
READY=fail
for _ in $(seq 1 60); do
  if "$SPRITE" exec --no-stdin -s "$WORKER_A" -- true >/dev/null 2>&1; then READY=pass; break; fi
  sleep 5
done
RESTORE_MS=$(( $(ms) - RESTORE_T0 ))
check "restore_ready_within_300s" "$READY"

RSHA2="$(remote_sha "$WORKER_A" bundle.json)"
check "bundle_restored_$WORKER_A" "$([ "$RSHA2" = "$LOCAL_SHA" ] && echo pass || echo fail)"
if remote_rc "$WORKER_A" "test -e $REMOTE_DIR/post-$MARKER"; then
  check "post_checkpoint_marker_gone" fail
else
  check "post_checkpoint_marker_gone" pass
fi
if remote_rc "$WORKER_A" "test -e $REMOTE_DIR/$MARKER"; then
  check "pre_checkpoint_marker_kept" pass
else
  check "pre_checkpoint_marker_kept" fail
fi

RSHA_B="$(remote_sha "$WORKER_B" bundle.json)"
check "bundle_unchanged_$WORKER_B" "$([ "$RSHA_B" = "$LOCAL_SHA" ] && echo pass || echo fail)"
if remote_rc "$WORKER_B" "test -e $REMOTE_DIR/$MARKER"; then
  check "no_a_marker_on_${WORKER_B}_after_restore" fail
else
  check "no_a_marker_on_${WORKER_B}_after_restore" pass
fi

# --- verdict + summary --------------------------------------------------------
# skipped checks (connector not configured) are reported but do not fail the run
ALL_PASS=1
for R in "${CHECK_RESULTS[@]}"; do [ "$R" != fail ] || ALL_PASS=0; done

DELETED=false
if [ "$ALL_PASS" = 1 ] && [ -n "${VER:-}" ]; then
  if "$SPRITE" checkpoint delete -s "$WORKER_A" "$VER" >/dev/null 2>&1; then DELETED=true; fi
fi

CHECKS_JSON=""
for i in "${!CHECK_NAMES[@]}"; do
  case "${CHECK_RESULTS[$i]}" in
    pass) V=true ;;
    fail) V=false ;;
    *) V="\"${CHECK_RESULTS[$i]}\"" ;;
  esac
  CHECKS_JSON+="\"${CHECK_NAMES[$i]}\":$V,"
done
CHECKS_JSON="${CHECKS_JSON%,}"

cat > "$OUT" <<JSON
{
  "proof": "caveat-m1-isolation",
  "ranAt": "$STAMP",
  "workers": ["$WORKER_A", "$WORKER_B"],
  "bundleSha256": "$LOCAL_SHA",
  "checks": {$CHECKS_JSON},
  "observed": {
    "listedProvidersA": "${LISTED_PROVIDERS_wa:-n/a}",
    "listedProvidersB": "${LISTED_PROVIDERS_wb:-n/a}",
    "boxHttpA": "${BOX_CODE_wa:-n/a}",
    "boxHttpB": "${BOX_CODE_wb:-n/a}",
    "geminiHttpA": "${GEMINI_CODE_wa:-n/a}",
    "geminiHttpB": "${GEMINI_CODE_wb:-n/a}"
  },
  "checkpoint": {
    "version": "${VER:-none}",
    "deletedAfterPass": $DELETED
  },
  "timingsMs": {
    "checkpointCreate": $CHECKPOINT_CREATE_MS,
    "restoreUntilReady": $RESTORE_MS
  },
  "result": "$([ "$ALL_PASS" = 1 ] && echo pass || echo fail)"
}
JSON

cat "$OUT"
[ "$ALL_PASS" = 1 ]
