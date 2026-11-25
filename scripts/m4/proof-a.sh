#!/usr/bin/env bash
# Milestone-4 phase A proof against the live coordinator:
#   a. deploy + service running + footer revision == HEAD
#   b. signed-out requests to the public URL are never 2xx
#   c. POST /runs -> reviewable, page shows the decision/flag/policy text
#   d. tampered approve 409; approve; idempotent re-approve; 1 approval row
#   e. export -> 200; downloaded bytes' sha256 == draft_hash
#   f. Box access-policy denial -> export 503, run still approved
#   g. service restart -> same receipt hash, approval and export rows persist
# Drives the app through `sprite proxy` so no token is ever handled here.
set -uo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
SERVICE="${CAVEAT_SERVICE:-caveat}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIVATE="${CAVEAT_PRIVATE:-$HOME/caveat-private}"
EVIDENCE_DIR="$PRIVATE/m4"
TS="$(date +%Y%m%dT%H%M%S)"
SUMMARY="$EVIDENCE_DIR/proof-a-$TS.json"
LOCAL_PORT="${CAVEAT_PROXY_PORT:-18080}"
BASE="http://127.0.0.1:$LOCAL_PORT"
# The Box connector id is discovered at runtime — it is account data, not code.
CONNECTION=""
ORIGINAL_POLICY='{"access_policy":{"sprite_labels":["caveat-proof"],"allowed_endpoints":["/2.0/folders/*","/2.0/files/*"],"blocked_endpoints":["/upload/*"]}}'

mkdir -p "$EVIDENCE_DIR"
RESULTS="$EVIDENCE_DIR/.proof-$TS.ndjson"
: >"$RESULTS"
note() { printf '%s\n' "$1" >>"$RESULTS"; }
fail() { echo "PROOF FAIL: $1" >&2; note "{\"step\":\"fail\",\"detail\":\"$1\"}"; exit 1; }

PROXY_PID=""
restore_policy() {
  sprite api "/v1/oauth/connections/$CONNECTION" -- -s -X PUT \
    -H 'Content-Type: application/json' -d "$ORIGINAL_POLICY" >/dev/null 2>&1 || true
}
cleanup() {
  restore_policy
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

# --- a. deploy ---------------------------------------------------------------
CONNECTION="$(sprite api "/v1/oauth/connections" -- -s 2>/dev/null | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const body=JSON.parse(d);
    const list=Array.isArray(body)?body:(body.connections??[]);
    const box=list.filter((c)=>c.provider==="box");
    if(box.length!==1){console.error(`want exactly 1 box connection, got ${box.length}`);process.exit(1)}
    console.log(box[0].id);
  });')" || fail "could not discover the Box connection"

bash "$REPO_ROOT/scripts/m4/deploy.sh" >&2 || fail "deploy.sh"
REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"

sprite proxy -s "$SPRITE" "$LOCAL_PORT:8080" >/dev/null 2>&1 &
PROXY_PID=$!

READY=""
for _ in $(seq 1 120); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz" 2>/dev/null)" = "200" ]; then
    READY=1; break
  fi
  sleep 5
done
[ -n "$READY" ] || fail "service never became healthy on :$LOCAL_PORT"
note "{\"step\":\"a\",\"service\":\"running\"}"

HOME_PAGE="$(curl -s "$BASE/")"
echo "$HOME_PAGE" | grep -q "deployed revision $REVISION" \
  || fail "footer revision does not match HEAD $REVISION"
note "{\"step\":\"a\",\"revision\":\"$REVISION\"}"

# --- b. signed-out ------------------------------------------------------------
COORD_URL="$(sprite info -s "$SPRITE" | awk '/^URL:/ {print $2}')"
[ -n "$COORD_URL" ] || fail "no public URL for $SPRITE"
CODES=""
check_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@")"
  case "$code" in 2*) fail "signed-out request returned $code for $*";; esac
  CODES="${CODES:+$CODES,}$code"
}
check_code "$COORD_URL/"
check_code "$COORD_URL/runs/x"
check_code -X POST "$COORD_URL/runs"
check_code -X POST "$COORD_URL/runs/x/approve"
check_code -X POST "$COORD_URL/runs/x/export"
note "{\"step\":\"b\",\"codes\":\"$CODES\"}"

# --- c. run -------------------------------------------------------------------
post() {
  curl -s -D- -o "$EVIDENCE_DIR/.proof-body" --max-time 30 \
    -X POST -H "Origin: $BASE" "$@"
}
RUN_LOCATION="$(post "$BASE/runs" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')"
[ -n "$RUN_LOCATION" ] || fail "POST /runs did not redirect"
RUN_ID="${RUN_LOCATION##*/runs/}"
note "{\"step\":\"c\",\"run_id\":\"$RUN_ID\"}"

RUN_PAGE=""
for _ in $(seq 1 240); do
  RUN_PAGE="$(curl -s "$BASE/runs/$RUN_ID")"
  if echo "$RUN_PAGE" | grep -q 'badge--reviewable\|badge--needs_review\|badge--failed'; then
    break
  fi
  sleep 5
done
echo "$RUN_PAGE" | grep -q 'badge--reviewable' || fail "run $RUN_ID did not become reviewable"
echo "$RUN_PAGE" | grep -q 'Escrow release' || fail "run page lacks the escrow_release decision"
echo "$RUN_PAGE" | grep -q 'from December 31, 2026 until March 31, 2026' || fail "run page lacks the flag text"
echo "$RUN_PAGE" | grep -q 'Runner policy' || fail "run page lacks the runner-policy text"
note "{\"step\":\"c\",\"status\":\"reviewable\"}"

RECEIPT_HASH="$(echo "$RUN_PAGE" | grep -oE 'name="receiptHash" value="[0-9a-f]+"' | grep -oE '[0-9a-f]{64}')"
DRAFT_HASH="$(echo "$RUN_PAGE" | grep -oE 'name="draftHash" value="[0-9a-f]+"' | grep -oE '[0-9a-f]{64}')"
[ -n "$RECEIPT_HASH" ] && [ -n "$DRAFT_HASH" ] || fail "could not read hashes from the run page"

db_query() {
  sprite exec --no-stdin -s "$SPRITE" -- node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/home/sprite/caveat-data/caveat.db");
    console.log(JSON.stringify(db.prepare(process.argv[1]).all()));
    db.close();
  ' "$1"
}

# --- d. approve ---------------------------------------------------------------
CODE="$(post -d "receiptHash=$RECEIPT_HASH&draftHash=deadbeef" "$BASE/runs/$RUN_ID/approve" | awk 'NR==1 {print $2}')"
[ "$CODE" = "409" ] || fail "tampered approve returned $CODE, want 409"
note "{\"step\":\"d\",\"tampered\":409}"

CODE="$(post -d "receiptHash=$RECEIPT_HASH&draftHash=$DRAFT_HASH" "$BASE/runs/$RUN_ID/approve" | awk 'NR==1 {print $2}')"
[ "$CODE" = "303" ] || fail "approve returned $CODE, want 303"
CODE="$(post -d "receiptHash=$RECEIPT_HASH&draftHash=$DRAFT_HASH" "$BASE/runs/$RUN_ID/approve" | awk 'NR==1 {print $2}')"
[ "$CODE" = "303" ] || fail "repeat approve returned $CODE, want 303"

APPROVALS="$(db_query "SELECT id, approved_by FROM approvals WHERE run_id = '$RUN_ID'")"
APPROVAL_COUNT="$(echo "$APPROVALS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')"
[ "$APPROVAL_COUNT" = "1" ] || fail "expected 1 approval row, got $APPROVALS"
note "{\"step\":\"d\",\"approvals\":$APPROVALS}"

# --- e. export ----------------------------------------------------------------
DRAFT_FILE="$EVIDENCE_DIR/caveat-draft-$RUN_ID-v1.txt"
HEADERS="$(post "$BASE/runs/$RUN_ID/export")"
CODE="$(echo "$HEADERS" | awk 'NR==1 {print $2}')"
[ "$CODE" = "200" ] || fail "export returned $CODE, want 200"
echo "$HEADERS" | grep -qi "content-disposition: attachment; filename=\"caveat-draft-$RUN_ID-v1.txt\"" \
  || fail "export lacked the expected Content-Disposition"
cp "$EVIDENCE_DIR/.proof-body" "$DRAFT_FILE"
GOT_SHA="$(shasum -a 256 "$DRAFT_FILE" | awk '{print $1}')"
[ "$GOT_SHA" = "$DRAFT_HASH" ] || fail "exported bytes sha256 $GOT_SHA != draft_hash $DRAFT_HASH"
note "{\"step\":\"e\",\"draft_sha256\":\"$GOT_SHA\",\"file\":\"caveat-draft-$RUN_ID-v1.txt\"}"

# --- f. Box denied -------------------------------------------------------------
sprite api "/v1/oauth/connections/$CONNECTION" -- -s -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"access_policy":{"sprite_labels":["caveat-proof","caveat-maintenance-hold"],"allowed_endpoints":["/2.0/folders/*","/2.0/files/*"],"blocked_endpoints":["/upload/*"]}}' \
  >/dev/null || fail "could not tighten the access policy"

CODE="$(post "$BASE/runs/$RUN_ID/export" | awk 'NR==1 {print $2}')"
[ "$CODE" = "503" ] || fail "export under denied Box returned $CODE, want 503"

RUN_STATUS="$(db_query "SELECT status FROM runs WHERE id = '$RUN_ID'" | grep -o '"status":"[a-z_]*"' | cut -d'"' -f4)"
[ "$RUN_STATUS" = "approved" ] || fail "run status became $RUN_STATUS under denied Box"
EXPORT_ROWS="$(db_query "SELECT result FROM exports WHERE run_id = '$RUN_ID' ORDER BY at, id")"
echo "$EXPORT_ROWS" | grep -q 'blocked_unavailable' || fail "no blocked_unavailable export row: $EXPORT_ROWS"
note "{\"step\":\"f\",\"status\":\"approved\",\"export_rows\":$EXPORT_ROWS}"

restore_policy
POLICY="$(sprite api "/v1/oauth/connections/$CONNECTION" -- -s 2>/dev/null)"
echo "$POLICY" | node -e '
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    }
    return v;
  };
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const want=canon(JSON.parse(process.argv[1]).access_policy);
    const conn=JSON.parse(d).connection ?? JSON.parse(d);
    const got=canon(conn.access_policy);
    if(JSON.stringify(got)===JSON.stringify(want)){console.log("ok")}else{console.log("mismatch: "+JSON.stringify(got))}
  });' "$ORIGINAL_POLICY" | grep -q '^ok$' || fail "access policy was not restored to the original"
note "{\"step\":\"f\",\"policy\":\"restored\"}"

# --- g. persistence -------------------------------------------------------------
sprite exec --no-stdin -s "$SPRITE" -- sprite-env services restart "$SERVICE" >/dev/null 2>&1 \
  || fail "service restart failed"
READY=""
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz" 2>/dev/null)" = "200" ]; then
    READY=1; break
  fi
  sleep 5
done
[ -n "$READY" ] || fail "service did not come back after restart"

RUN_PAGE="$(curl -s "$BASE/runs/$RUN_ID")"
echo "$RUN_PAGE" | grep -q "$RECEIPT_HASH" || fail "receipt hash changed after restart"
echo "$RUN_PAGE" | grep -q 'Approved by' || fail "approval missing after restart"
EXPORT_ROWS="$(db_query "SELECT result FROM exports WHERE run_id = '$RUN_ID' ORDER BY at, id")"
EXPORT_COUNT="$(echo "$EXPORT_ROWS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')"
[ "$EXPORT_COUNT" = "2" ] || fail "expected 2 export rows after restart, got $EXPORT_ROWS"
note "{\"step\":\"g\",\"receipt_hash\":\"$RECEIPT_HASH\",\"export_rows\":$EXPORT_ROWS}"

node -e '
  const fs = require("fs");
  const steps = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  console.log(JSON.stringify({ proof: "m4-phase-a", ts: process.argv[2], sprite: process.argv[3], runId: steps.find(s=>s.run_id)?.run_id ?? null, steps }, null, 2));
' "$RESULTS" "$TS" "$SPRITE" >"$SUMMARY"
rm -f "$RESULTS" "$EVIDENCE_DIR/.proof-body"
echo "PROOF PASS: $SUMMARY"
