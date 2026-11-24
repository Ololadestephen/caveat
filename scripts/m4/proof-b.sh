#!/usr/bin/env bash
# Milestone-4 phase B proof: the owner re-uploaded 03 as a NEW Box version
# (same bytes). Expect, on the still-running previous deploy:
#   1. export of the approved run -> 409, run -> stale (version_changed only,
#      same sha12), stale banner + refused approve/export
#   2. redeploy HEAD -> migration 2 applied, run unchanged
#   3. new run -> reviewable, new 03 versionTag same sha256, different receipt
#      hash, every older run superseded_by it
#   4. approve + export -> 200, bytes == draft_hash, draft diff = Run/Receipt
#   5. signed-out -> non-2xx
set -uo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
SERVICE="${CAVEAT_SERVICE:-caveat}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIVATE="${CAVEAT_PRIVATE:-$HOME/caveat-private}"
EVIDENCE_DIR="$PRIVATE/m4"
TS="$(date +%Y%m%dT%H%M%S)"
SUMMARY="$EVIDENCE_DIR/proof-b-$TS.json"
LOCAL_PORT="${CAVEAT_PROXY_PORT:-18080}"
BASE="http://127.0.0.1:$LOCAL_PORT"

OLD_RUN="${CAVEAT_OLD_RUN:-run-20261124-135243-64d7}"
OLD_RECEIPT_SHA="${CAVEAT_OLD_RECEIPT_SHA:-13e20dd6ac7df29892131127f2fe186d2b0b1267173470d0200ad5846b169cfc}"
OLD_DRAFT="$EVIDENCE_DIR/caveat-draft-$OLD_RUN-v1.txt"
CHANGED_FILE="03-second-amendment.pdf"
CHANGED_SHA12="a36ff3a50c18"

mkdir -p "$EVIDENCE_DIR"
RESULTS="$EVIDENCE_DIR/.proof-b-$TS.ndjson"
: >"$RESULTS"
note() { printf '%s\n' "$1" >>"$RESULTS"; }
fail() { echo "PROOF FAIL: $1" >&2; note "{\"step\":\"fail\",\"detail\":\"$1\"}"; exit 1; }

PROXY_PID=""
cleanup() { [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT

post() {
  curl -s -D- -o "$EVIDENCE_DIR/.proof-b-body" --max-time 30 \
    -X POST -H "Origin: $BASE" "$@"
}
code() { awk 'NR==1 {print $2}'; }

db_query() {
  sprite exec --no-stdin -s "$SPRITE" -- node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/home/sprite/caveat-data/caveat.db");
    console.log(JSON.stringify(db.prepare(process.argv[1]).all()));
    db.close();
  ' "$1"
}

wait_ready() {
  for _ in $(seq 1 120); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# --- 0. current deployment is up, old run approved ----------------------------
sprite proxy -s "$SPRITE" "$LOCAL_PORT:8080" >/dev/null 2>&1 &
PROXY_PID=$!
wait_ready || fail "service not healthy on :$LOCAL_PORT"

OLD_ROW="$(db_query "SELECT status, receipt_hash, draft_hash, superseded_by FROM runs WHERE id = '$OLD_RUN'")"
OLD_STATUS="$(echo "$OLD_ROW" | grep -oE '"status":"[a-z_]+"' | cut -d'"' -f4)"
# The run may already be stale if a previous attempt got this far — the
# assertions below are the same either way, only the marking export differs.
if [ "$OLD_STATUS" != "approved" ] && [ "$OLD_STATUS" != "stale" ]; then
  fail "old run in unexpected status $OLD_STATUS: $OLD_ROW"
fi
echo "$OLD_ROW" | grep -q "$OLD_RECEIPT_SHA" || fail "old receipt hash drifted: $OLD_ROW"
OLD_DRAFT_SHA="$(echo "$OLD_ROW" | grep -oE '"draft_hash":"[0-9a-f]+"' | cut -d'"' -f4)"
[ -f "$OLD_DRAFT" ] || fail "missing phase-A draft $OLD_DRAFT"
note "{\"step\":\"0\",\"old_run\":\"$OLD_RUN\",\"old_status\":\"$OLD_STATUS\"}"

# --- 1. export on the old revision -> blocked_stale ---------------------------
if [ "$OLD_STATUS" = "approved" ]; then
  CODE="$(post "$BASE/runs/$OLD_RUN/export" | code)"
  [ "$CODE" = "409" ] || fail "export on new-version evidence returned $CODE, want 409"
  note "{\"step\":\"1\",\"export_code\":409}"
else
  note "{\"step\":\"1\",\"export_code\":\"skipped (already stale)\"}"
fi

STALE="$(db_query "SELECT status, stale_detail_json FROM runs WHERE id = '$OLD_RUN'")"
STALE_DETAIL="$(echo "$STALE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d)[0];if(r.status!=="stale"){console.log("STATUS:"+r.status);process.exit(0)}console.log(r.stale_detail_json)})')"
[ "${STALE_DETAIL%%:*}" = "STATUS" ] && fail "run did not become stale: $STALE"
echo "$STALE_DETAIL" | node -e '
  const file = process.argv[1], sha12 = process.argv[2];
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const changes = JSON.parse(d);
    const errs = [];
    if (changes.length !== 1) errs.push(`want exactly 1 change, got ${changes.length}`);
    for (const c of changes) {
      if (c.fileName !== file) errs.push(`unexpected file ${c.fileName}`);
      if (c.kind !== "version_changed") errs.push(`unexpected kind ${c.kind}`);
      if (c.oldSha12 !== sha12 || c.newSha12 !== sha12) errs.push("sha12 changed");
      if (!c.oldVersionTag || !c.newVersionTag || c.oldVersionTag === c.newVersionTag) errs.push("versionTag did not change");
    }
    console.log(errs.length ? errs.join("; ") : "ok");
  });' "$CHANGED_FILE" "$CHANGED_SHA12" | grep -q '^ok$' \
  || fail "stale_detail wrong: $STALE_DETAIL"
note "{\"step\":\"1\",\"stale_detail\":$STALE_DETAIL}"

EXPORTS="$(db_query "SELECT result FROM exports WHERE run_id = '$OLD_RUN' ORDER BY at, id")"
echo "$EXPORTS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).map(x=>x.result);console.log(JSON.stringify(r)==JSON.stringify(["exported","blocked_unavailable","blocked_stale"])?"ok":JSON.stringify(r))})' \
  | grep -q '^ok$' || fail "export rows wrong after stale: $EXPORTS"
note "{\"step\":\"1\",\"export_rows\":$EXPORTS}"

OLD_PAGE="$(curl -s "$BASE/runs/$OLD_RUN")"
echo "$OLD_PAGE" | grep -q "$OLD_RECEIPT_SHA" || fail "old page lost the receipt hash"
echo "$OLD_PAGE" | grep -qi "stale" || fail "old page lacks the stale banner"
echo "$OLD_PAGE" | grep -q "version_changed" || fail "old page lacks the change list"

# --- 2. redeploy HEAD ----------------------------------------------------------
# Approve/export refusals are checked after the deploy: the previous revision
# had an approve-ordering bug (idempotent approval returned before the status
# check) fixed in e81a1b1, so a stale run must be refused by the NEW revision.
bash "$REPO_ROOT/scripts/m4/deploy.sh" >&2 || fail "deploy.sh"
wait_ready || fail "service did not come back after redeploy"
REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
curl -s "$BASE/" | grep -q "deployed revision $REVISION" || fail "footer revision != HEAD $REVISION"
VERSION="$(db_query "PRAGMA user_version" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d)[0].user_version))')"
[ "$VERSION" = "2" ] || fail "PRAGMA user_version = $VERSION, want 2"
note "{\"step\":\"2\",\"revision\":\"$REVISION\",\"user_version\":2}"

OLD_ROW="$(db_query "SELECT status, receipt_hash FROM runs WHERE id = '$OLD_RUN'")"
echo "$OLD_ROW" | grep -q '"status":"stale"' || fail "old run status changed on redeploy: $OLD_ROW"
echo "$OLD_ROW" | grep -q "$OLD_RECEIPT_SHA" || fail "old receipt hash changed on redeploy"
N="$(db_query "SELECT COUNT(*) AS n FROM approvals WHERE run_id = '$OLD_RUN'" | grep -oE '[0-9]+')"
[ "$N" = "1" ] || fail "approval rows changed on redeploy: $N"
E="$(db_query "SELECT COUNT(*) AS n FROM exports WHERE run_id = '$OLD_RUN'" | grep -oE '[0-9]+')"
[ "$E" = "3" ] || fail "export rows changed on redeploy: $E"
note "{\"step\":\"2\",\"old_run\":\"unchanged\"}"

CODE="$(post -d "receiptHash=$OLD_RECEIPT_SHA&draftHash=$OLD_DRAFT_SHA" "$BASE/runs/$OLD_RUN/approve" | code)"
[ "$CODE" = "409" ] || fail "approve on stale returned $CODE"
CODE="$(post "$BASE/runs/$OLD_RUN/export" | code)"
[ "$CODE" = "409" ] || fail "export on stale returned $CODE"
note "{\"step\":\"2\",\"stale_refusals\":true}"

# --- 3. new run -> reviewable ---------------------------------------------------
RUN_LOCATION="$(post "$BASE/runs" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')"
[ -n "$RUN_LOCATION" ] || fail "POST /runs did not redirect"
NEW_RUN="${RUN_LOCATION##*/runs/}"
note "{\"step\":\"3\",\"run_id\":\"$NEW_RUN\"}"

NEW_PAGE=""
for _ in $(seq 1 60); do
  NEW_PAGE="$(curl -s "$BASE/runs/$NEW_RUN")"
  if echo "$NEW_PAGE" | grep -q 'badge--reviewable\|badge--needs_review\|badge--failed'; then
    break
  fi
  sleep 5
done
echo "$NEW_PAGE" | grep -q 'badge--reviewable' || fail "new run did not become reviewable"
echo "$NEW_PAGE" | grep -q 'Escrow release' || fail "new page lacks the decision"
echo "$NEW_PAGE" | grep -q 'from December 31, 2026 until March 31, 2026' || fail "new page lacks the flag"
echo "$NEW_PAGE" | grep -q 'Runner policy' || fail "new page lacks the policy text"

NEW_ROW="$(db_query "SELECT receipt_hash, draft_hash, source_tuple_json FROM runs WHERE id = '$NEW_RUN'")"
OLD_TUPLE="$(db_query "SELECT source_tuple_json FROM runs WHERE id = '$OLD_RUN'")"
TUPLE_CHECK="$(printf '%s\n%s\n' "$NEW_ROW" "$OLD_TUPLE" | node -e '
  const { createHash } = require("node:crypto");
  const tag = (f) => createHash("sha256").update(`${f.fileId}:${f.versionId}`).digest("hex").slice(0, 12);
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const [row, oldRow] = d.trim().split("\n").map(JSON.parse);
    const n = row[0], o = JSON.parse(oldRow[0].source_tuple_json);
    const t = JSON.parse(n.source_tuple_json);
    const by = (arr, name) => arr.find((f) => f.fileName === name);
    const n3 = by(t, "03-second-amendment.pdf"), o3 = by(o, "03-second-amendment.pdf");
    const out = { receipt_differs: n.receipt_hash !== "'"$OLD_RECEIPT_SHA"'",
      tag_changed: tag(n3) !== tag(o3), sha_same: n3.sha256 === o3.sha256,
      newTag: tag(n3), sha12: n3.sha256.slice(0, 12) };
    console.log(JSON.stringify(out));
  });')"
echo "$TUPLE_CHECK" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(r.receipt_differs&&r.tag_changed&&r.sha_same?"ok":JSON.stringify(r))})' \
  | grep -q '^ok$' || fail "tuple/receipt check failed: $TUPLE_CHECK"
NEW_RECEIPT_SHA="$(echo "$NEW_ROW" | grep -oE '"receipt_hash":"[0-9a-f]+"' | cut -d'"' -f4)"
NEW_DRAFT_SHA="$(echo "$NEW_ROW" | grep -oE '"draft_hash":"[0-9a-f]+"' | cut -d'"' -f4)"
note "{\"step\":\"3\",\"receipt_hash\":\"$NEW_RECEIPT_SHA\",\"tuple\":$TUPLE_CHECK}"

NOT_SUPERSEDED="$(db_query "SELECT id FROM runs WHERE id != '$NEW_RUN' AND (superseded_by IS NULL OR superseded_by != '$NEW_RUN')")"
[ "$NOT_SUPERSEDED" = "[]" ] || fail "runs not superseded by $NEW_RUN: $NOT_SUPERSEDED"
curl -s "$BASE/runs/$OLD_RUN" | grep -q "/runs/$NEW_RUN" || fail "old page does not link to the new run"
note "{\"step\":\"3\",\"superseded_by\":\"$NEW_RUN\"}"

# --- 4. approve + export + draft diff -------------------------------------------
CODE="$(post -d "receiptHash=$NEW_RECEIPT_SHA&draftHash=$NEW_DRAFT_SHA" "$BASE/runs/$NEW_RUN/approve" | code)"
[ "$CODE" = "303" ] || fail "approve new run returned $CODE"
CODE="$(post "$BASE/runs/$NEW_RUN/export" | code)"
[ "$CODE" = "200" ] || fail "export new run returned $CODE"
NEW_DRAFT="$EVIDENCE_DIR/caveat-draft-$NEW_RUN-v1.txt"
cp "$EVIDENCE_DIR/.proof-b-body" "$NEW_DRAFT"
GOT_SHA="$(shasum -a 256 "$NEW_DRAFT" | awk '{print $1}')"
[ "$GOT_SHA" = "$NEW_DRAFT_SHA" ] || fail "exported sha $GOT_SHA != draft_hash $NEW_DRAFT_SHA"
note "{\"step\":\"4\",\"draft_sha256\":\"$GOT_SHA\",\"file\":\"caveat-draft-$NEW_RUN-v1.txt\"}"

DIFF="$(diff -u "$OLD_DRAFT" "$NEW_DRAFT" || true)"
UNEXPECTED="$(echo "$DIFF" | grep -E '^[+-][^+-]' | grep -vE '^[+-](Run: |Receipt: )' || true)"
[ -z "$UNEXPECTED" ] || fail "draft differs beyond Run/Receipt lines: $UNEXPECTED"
echo "$DIFF" | grep -q "^-Run: $OLD_RUN" || fail "diff lacks the old Run line"
echo "$DIFF" | grep -q "^+Run: $NEW_RUN" || fail "diff lacks the new Run line"
echo "$DIFF" | grep -q "^-Receipt: sha256 $OLD_RECEIPT_SHA" || fail "diff lacks the old Receipt line"
note "{\"step\":\"4\",\"diff_changed\":\"Run and Receipt lines only\"}"

# --- 5. signed-out on the new run -----------------------------------------------
COORD_URL="$(sprite info -s "$SPRITE" | awk '/^URL:/ {print $2}')"
CODES=""
for REQ in "GET $COORD_URL/runs/$NEW_RUN" "POST $COORD_URL/runs/$NEW_RUN/approve" "POST $COORD_URL/runs/$NEW_RUN/export"; do
  M="${REQ%% *}"; U="${REQ#* }"
  if [ "$M" = "POST" ]; then CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$U")"
  else CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$U")"; fi
  case "$CODE" in 2*) fail "signed-out $REQ returned $CODE";; esac
  CODES="${CODES:+$CODES,}$CODE"
done
note "{\"step\":\"5\",\"codes\":\"$CODES\"}"

node -e '
  const fs = require("fs");
  const steps = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  console.log(JSON.stringify({ proof: "m4-phase-b", ts: process.argv[2], sprite: process.argv[3], runId: steps.find((s)=>s.run_id)?.run_id ?? null, steps }, null, 2));
' "$RESULTS" "$TS" "$SPRITE" >"$SUMMARY"
rm -f "$RESULTS" "$EVIDENCE_DIR/.proof-b-body"
echo "PROOF PASS: $SUMMARY"
