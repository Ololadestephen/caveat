#!/usr/bin/env bash
# Milestone-1 isolation proof, run from the operator Mac with the sprite CLI.
# (a) identical bundle sha256 on both workers
# (b) a marker written on A is absent on B
# (c) workers are denied the connector gateways (expected HTTP 403)
# (d) checkpoint A -> mutate -> restore -> original content back, post-marker
#     gone, pre-marker kept, B untouched
# Writes a sanitized JSON summary to ~/caveat-private/m1/isolation-<ts>.json
# and exits 1 if any check fails, 3 if a check was skipped (incomplete).
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
OPENROUTER_GW="$(GW_OF openrouter)"

# Worker connectors are custom_api entries named caveat-worker-a/-b (their
# label lives in provider_account_name / display_name, not `name`).
GW_NAMED() {
  printf '%s' "$LIST_JSON" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const j=JSON.parse(d);
      const want=process.argv[1];
      const c=(j.connections||[]).find(x=>x.name===want||x.provider_account_name===want||x.display_name===want);
      console.log(c?c.gateway_base_url:"");
    });' "$1" 2>/dev/null
}
WORKER_A_GW="$(GW_NAMED "${CAVEAT_WORKER_A_CONN:-caveat-worker-a}")"
WORKER_B_GW="$(GW_NAMED "${CAVEAT_WORKER_B_CONN:-caveat-worker-b}")"

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

  if [ -n "$OPENROUTER_GW" ]; then
    CODE=$(remote "$W" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST '$OPENROUTER_GW/v1/chat/completions' -H 'Content-Type: application/json' -d '{\"model\":\"probe\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'" || echo "000")
    eval "OPENROUTER_CODE_${W#caveat-}=$CODE"
    check "openrouter_gateway_denied_$W" "$([ "$CODE" = 403 ] && echo pass || echo fail)"
  else
    eval "OPENROUTER_CODE_${W#caveat-}=not_configured"
    check "openrouter_gateway_denied_$W" skipped_not_configured
  fi

  # Both worker connectors must refuse calls from the workers themselves.
  for SIDE in a b; do
    SIDE_UP="$(printf '%s' "$SIDE" | tr '[:lower:]' '[:upper:]')"
    eval "CGW=\$WORKER_${SIDE_UP}_GW"
    if [ -n "$CGW" ]; then
      CODE=$(remote "$W" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST '$CGW/run-batch' -H 'Content-Type: application/json' -d '{\"jobs\":[]}'" || echo "000")
      eval "WORKERCONN_${SIDE}_${W#caveat-}=$CODE"
      check "worker_connector_${SIDE}_denied_$W" "$([ "$CODE" = 403 ] && echo pass || echo fail)"
    else
      eval "WORKERCONN_${SIDE}_${W#caveat-}=not_configured"
      check "worker_connector_${SIDE}_denied_$W" skipped_not_configured
    fi
  done
done

# --- (c2) worker endpoints are not public ------------------------------------
# From this Mac, with no auth at all, the org-private Sprite URL must not serve
# the batch endpoint. Any non-200 (401/403/redirect-to-login) proves it.
for W in "$WORKER_A" "$WORKER_B"; do
  WORKER_URL="$("$SPRITE" info -s "$W" 2>/dev/null | awk '/^URL:/{print $2}')"
  if [ -n "$WORKER_URL" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WORKER_URL/healthz" || echo "000")
    eval "UNAUTH_${W#caveat-}=$CODE"
    check "worker_url_unauthenticated_$W" "$([ "$CODE" != 200 ] && echo pass || echo fail)"
  else
    eval "UNAUTH_${W#caveat-}=no_url"
    check "worker_url_unauthenticated_$W" fail
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
ANY_SKIPPED=0
for R in "${CHECK_RESULTS[@]}"; do
  [ "$R" != fail ] || ALL_PASS=0
  [ "$R" != skipped_not_configured ] || ANY_SKIPPED=1
done

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
    "openrouterHttpA": "${OPENROUTER_CODE_wa:-n/a}",
    "openrouterHttpB": "${OPENROUTER_CODE_wb:-n/a}",
    "workerConnAhttpA": "${WORKERCONN_a_wa:-n/a}",
    "workerConnAhttpB": "${WORKERCONN_a_wb:-n/a}",
    "workerConnBhttpA": "${WORKERCONN_b_wa:-n/a}",
    "workerConnBhttpB": "${WORKERCONN_b_wb:-n/a}",
    "unauthHealthzA": "${UNAUTH_wa:-n/a}",
    "unauthHealthzB": "${UNAUTH_wb:-n/a}"
  },
  "checkpoint": {
    "version": "${VER:-none}",
    "deletedAfterPass": $DELETED
  },
  "timingsMs": {
    "checkpointCreate": $CHECKPOINT_CREATE_MS,
    "restoreUntilReady": $RESTORE_MS
  },
  "result": "$([ "$ALL_PASS" = 0 ] && echo fail || { [ "$ANY_SKIPPED" = 1 ] && echo incomplete || echo pass; })"
}
JSON

cat "$OUT"
[ "$ALL_PASS" = 1 ] || exit 1
[ "$ANY_SKIPPED" = 0 ] || exit 3
