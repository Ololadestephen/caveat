#!/usr/bin/env bash
# Milestone-6 proof against the live coordinator: a manual run performs the
# counteroffer search on the two worker Sprites through their per-worker
# connectors.
#   a. POST /runs -> reviewable (one retry only on a model-failure needs_review)
#   b. receipt: v2 with sectionDigests + typedCallDigests; counteroffer found,
#      1-4 rounds, best passesAll, workers caveat-wa/-b, both used if >=2 tested
#   c. local recompute of the best candidate -> resultDigests equal
#   d. run page: exact headline, "Counteroffer search" section, one Model's note
#      per round; draft has "5. Proposed change, tested by Caveat:"
#   e. approve with the exact hashes; export sha256 == draft_hash
# The run ends as the newest approved run — the demo baseline.
set -uo pipefail

SPRITE="${CAVEAT_COORD_SPRITE:-caveat-coord}"
SERVICE="${CAVEAT_SERVICE:-caveat}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRIVATE="${CAVEAT_PRIVATE:-$HOME/caveat-private}"
REVIEW_FILE="$PRIVATE/reviews/retainer-review.json"
EVIDENCE_DIR="$PRIVATE/m6"
TS="$(date +%Y%m%dT%H%M%S)"
SUMMARY="$EVIDENCE_DIR/proof-search-$TS.json"
LOCAL_PORT="${CAVEAT_PROXY_PORT:-18080}"
BASE="http://127.0.0.1:$LOCAL_PORT"
RUN_WAIT_S="${CAVEAT_RUN_WAIT_S:-1260}"

mkdir -p "$EVIDENCE_DIR"
RESULTS="$EVIDENCE_DIR/.proof-$TS.ndjson"
: >"$RESULTS"
note() { printf '%s\n' "$1" >>"$RESULTS"; }
fail() {
  echo "PROOF FAIL: $1" >&2
  note "{\"step\":\"fail\",\"detail\":\"$1\"}"
  node -e '
    const fs = require("fs");
    const steps = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    fs.writeFileSync(process.argv[2], JSON.stringify({ proof: "m6-search", ts: process.argv[3], outcome: "fail", steps }, null, 2));
  ' "$RESULTS" "$SUMMARY" "$TS"
  exit 1
}

PROXY_PID=""
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

[ -f "$REVIEW_FILE" ] || fail "missing private review file: $REVIEW_FILE"

# --- proxy --------------------------------------------------------------------
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
note "{\"step\":\"proxy\",\"service\":\"running\"}"

post() {
  curl -s -D- -o "$EVIDENCE_DIR/.proof-body" --max-time 30 \
    -X POST -H "Origin: $BASE" "$@"
}

db_query() {
  sprite exec --no-stdin -s "$SPRITE" -- node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/home/sprite/caveat-data/caveat.db");
    console.log(JSON.stringify(db.prepare(process.argv[1]).all()));
    db.close();
  ' "$1"
}

receipt_for() {  # $1 = run id; writes receipt_json to stdout
  sprite exec --no-stdin -s "$SPRITE" -- node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/home/sprite/caveat-data/caveat.db");
    const row = db.prepare("SELECT receipt_json FROM runs WHERE id = ?").get(process.argv[1]);
    process.stdout.write(row ? row.receipt_json : "");
    db.close();
  ' "$1"
}

# --- a. start + wait ------------------------------------------------------------
start_run() {  # echoes the new run id; tolerates 409 while a run is in flight
  for _ in $(seq 1 60); do
    local resp loc code
    resp="$(post "$BASE/runs")"
    loc="$(echo "$resp" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')"
    if [ -n "$loc" ]; then
      echo "${loc##*/runs/}"
      return 0
    fi
    code="$(echo "$resp" | awk 'NR==1 {print $2}')"
    [ "$code" = "409" ] || return 1
    sleep 10
  done
  return 1
}

wait_run() {  # $1 = run id; echoes reviewable | needs_review | failed | timeout
  local id="$1" i
  for i in $(seq 1 $((RUN_WAIT_S / 10))); do
    curl -s --max-time 15 "$BASE/runs/$id" >"$EVIDENCE_DIR/.page-$id.html" 2>/dev/null
    if grep -q 'badge--reviewable\|badge--needs_review\|badge--failed' "$EVIDENCE_DIR/.page-$id.html"; then
      grep -oE 'badge--[a-z_]+' "$EVIDENCE_DIR/.page-$id.html" | head -1 | sed 's/badge--//'
      return 0
    fi
    sleep 10
  done
  echo "timeout"
}

# Retryable needs_review: every blocked reason (and the counteroffer reason, if
# it is the blocker) is a model failure — timeout / 429 / schema / truncation /
# provider errors / model gates — never a human-review or runner reason.
retryable() {  # $1 = receipt json file
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const modelFail = new Set([
      "timeout", "rate_limited", "schema_mismatch", "malformed_json", "truncated",
      "provider_error", "http_error", "network_error", "model_mismatch",
      "inconsistent_terms",
    ]);
    const reasons = (r.blockedReasons ?? []).map((b) => b.reason);
    if (r.counteroffer?.status === "needs_review" && r.counteroffer.reason) {
      reasons.push(r.counteroffer.reason);
    }
    process.exit(reasons.length > 0 && reasons.every((x) => modelFail.has(x)) ? 0 : 1);
  ' "$1"
}

RUN_ID=""
STATUS=""
for ATTEMPT in 1 2; do
  RUN_ID="$(start_run)" || fail "POST /runs did not redirect (attempt $ATTEMPT)"
  note "{\"step\":\"a\",\"attempt\":$ATTEMPT,\"run_id\":\"$RUN_ID\"}"
  STATUS="$(wait_run "$RUN_ID")"
  cp "$EVIDENCE_DIR/.page-$RUN_ID.html" "$EVIDENCE_DIR/run-page-$RUN_ID.html"
  receipt_for "$RUN_ID" >"$EVIDENCE_DIR/receipt-$RUN_ID.json"
  note "{\"step\":\"a\",\"attempt\":$ATTEMPT,\"status\":\"$STATUS\"}"
  [ "$STATUS" = "reviewable" ] && break
  if [ "$STATUS" = "needs_review" ] && [ "$ATTEMPT" = "1" ] && \
     retryable "$EVIDENCE_DIR/receipt-$RUN_ID.json"; then
    note "{\"step\":\"a\",\"retry\":\"model-failure needs_review, retrying once\"}"
    continue
  fi
  break
done
[ "$STATUS" = "reviewable" ] || fail "run $RUN_ID ended as $STATUS"
RUN_PAGE="$EVIDENCE_DIR/run-page-$RUN_ID.html"
RECEIPT="$EVIDENCE_DIR/receipt-$RUN_ID.json"

# --- b. receipt asserts + rounds table ------------------------------------------
ASSERT_OUT="$(node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const problems = [];
  if (r.receiptVersion !== "caveat-receipt/2") problems.push(`receiptVersion ${r.receiptVersion}`);
  if (!r.sectionDigests || typeof r.sectionDigests !== "object" || Object.keys(r.sectionDigests).length === 0)
    problems.push("no sectionDigests");
  const t = r.typedCallDigests ?? {};
  for (const k of ["release_timing", "escrow_schedule", "counteroffer_search"])
    if (typeof t[k] !== "string" || t[k].length === 0) problems.push(`no typedCallDigests.${k}`);
  const co = r.counteroffer;
  if (!co) problems.push("no counteroffer");
  const rounds = co?.rounds ?? [];
  if (co && co.status === "found") {
    if (rounds.length < 1 || rounds.length > 4) problems.push(`${rounds.length} rounds`);
    const all = rounds.flatMap((x) => x.candidates);
    const tested = all.filter((c) => c.status === "tested");
    const best = all.find((c) => c.id === co.best);
    if (!best) problems.push("best record missing");
    else if (best.passesAll !== true) problems.push("best.passesAll !== true");
    const workers = new Set(tested.map((c) => c.worker));
    for (const w of workers)
      if (w !== "caveat-wa" && w !== "caveat-wb") problems.push(`worker ${w}`);
    // Distribution is round-robin within a round; the search must exercise
    // both workers in at least one round, and any >=2-tested round must use
    // both.
    let sawParallel = false;
    for (const x of rounds) {
      const rt = x.candidates.filter((c) => c.status === "tested");
      const ws = new Set(rt.map((c) => c.worker));
      if (rt.length >= 2 && ws.size < 2)
        problems.push(`round ${x.round} used one worker for ${rt.length} candidates`);
      if (rt.length >= 2 && ws.size >= 2) sawParallel = true;
      // A not-done round must propose >=2 candidates on distinct levers.
      if (!x.done) {
        if (x.candidates.length < 2)
          problems.push(`round ${x.round} proposed ${x.candidates.length} candidates`);
        const levers = new Set(x.candidates.map((c) => c.lever));
        if (levers.size < x.candidates.length)
          problems.push(`round ${x.round} repeated a lever`);
      }
    }
    if (!sawParallel) problems.push("no round tested >=2 candidates on both workers");
  } else if (co) {
    problems.push(`status ${co.status}`);
  }
  const table = rounds.map((x) => ({
    round: x.round,
    done: x.done,
    modelNote: (x.modelNote ?? "").slice(0, 200),
    modelVersion: x.modelVersion ?? null,
    servedBy: x.servedBy ?? null,
    candidates: x.candidates.map((c) => ({
      id: c.id, lever: c.lever, params: c.params, status: c.status,
      worker: c.worker ?? null, passesAll: c.passesAll ?? null,
      rankCents: c.rankCents ?? null,
      rejection: c.rejection ? `${c.rejection.by}:${c.rejection.code}` : null,
    })),
  }));
  fs.writeFileSync(process.argv[2], JSON.stringify({
    status: co?.status ?? null, stopReason: co?.stopReason ?? null,
    best: co?.best ?? null, bound: co?.bound ?? null, rounds: table,
    humanReview: co?.humanReview ?? [],
    carriedFrom: co?.carriedFrom ?? null, reverifiedOn: co?.reverifiedOn ?? null,
  }, null, 2));
  if (problems.length > 0) {
    console.log(JSON.stringify({ status: co?.status ?? null, problems }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: co.status }));
' "$RECEIPT" "$EVIDENCE_DIR/search-rounds-$RUN_ID.json")" || {
  echo "search asserts: $ASSERT_OUT" >&2
  # not_found / not_needed are valid model outcomes: report, do not retry.
  note "{\"step\":\"b\",\"asserts\":$ASSERT_OUT}"
  node -e '
    const fs = require("fs");
    const steps = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    fs.writeFileSync(process.argv[2], JSON.stringify({ proof: "m6-search", ts: process.argv[3], outcome: "search_not_found_or_asserts_failed", steps }, null, 2));
  ' "$RESULTS" "$SUMMARY" "$TS"
  echo "PROOF REPORT (not found / asserts failed): $SUMMARY"
  exit 2
}
note "{\"step\":\"b\",\"status\":\"found\",\"rounds\":\"search-rounds-$RUN_ID.json\"}"

# --- c. local recompute ------------------------------------------------------------
node "$REPO_ROOT/scripts/m6/recompute-best.ts" "$RECEIPT" "$REVIEW_FILE" \
  >"$EVIDENCE_DIR/recompute-$RUN_ID.json" || {
  cat "$EVIDENCE_DIR/recompute-$RUN_ID.json" >&2 2>/dev/null || true
  fail "local recompute digests do not match the receipt"
}
note "{\"step\":\"c\",\"recompute\":\"match\"}"

# --- d. page + draft text ----------------------------------------------------------
grep -F '$8,000 under your floor on Dec 15, 2026 while $150,000 sits in escrow' \
  "$RUN_PAGE" >/dev/null || fail "run page lacks the exact headline"
grep -F 'Counteroffer search' "$RUN_PAGE" >/dev/null || fail "run page lacks the search section"
ROUNDS_N="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rounds.length)' "$EVIDENCE_DIR/search-rounds-$RUN_ID.json")"
NOTES_N="$(grep -o "Model's note" "$RUN_PAGE" | wc -l | tr -d ' ')"
[ "$NOTES_N" = "$ROUNDS_N" ] || fail "run page has $NOTES_N Model's note lines, want $ROUNDS_N"
BOUND_JSON="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bound ?? null))' "$EVIDENCE_DIR/search-rounds-$RUN_ID.json")"
if [ "$BOUND_JSON" != "null" ]; then
  grep -F 'Tested bound: ' "$RUN_PAGE" >/dev/null \
    || fail "run page lacks 'Tested bound:' though the receipt has a bound"
else
  grep -F 'not a proven minimum' "$RUN_PAGE" >/dev/null \
    || fail "run page lacks the no-bound wording"
fi
note "{\"step\":\"d\",\"rounds\":$ROUNDS_N,\"bound\":$BOUND_JSON}"

# --- e. approve + export -----------------------------------------------------------
RECEIPT_HASH="$(grep -oE 'name="receiptHash" value="[0-9a-f]+"' "$RUN_PAGE" | grep -oE '[0-9a-f]{64}')"
DRAFT_HASH="$(grep -oE 'name="draftHash" value="[0-9a-f]+"' "$RUN_PAGE" | grep -oE '[0-9a-f]{64}')"
[ -n "$RECEIPT_HASH" ] && [ -n "$DRAFT_HASH" ] || fail "could not read hashes from the run page"

CODE="$(post -d "receiptHash=$RECEIPT_HASH&draftHash=$DRAFT_HASH" "$BASE/runs/$RUN_ID/approve" | awk 'NR==1 {print $2}')"
[ "$CODE" = "303" ] || fail "approve returned $CODE, want 303"
note "{\"step\":\"e\",\"approved\":\"$RUN_ID\"}"

DRAFT_FILE="$EVIDENCE_DIR/caveat-draft-$RUN_ID-v1.txt"
HEADERS="$(post "$BASE/runs/$RUN_ID/export")"
CODE="$(echo "$HEADERS" | awk 'NR==1 {print $2}')"
[ "$CODE" = "200" ] || fail "export returned $CODE, want 200"
cp "$EVIDENCE_DIR/.proof-body" "$DRAFT_FILE"
GOT_SHA="$(shasum -a 256 "$DRAFT_FILE" | awk '{print $1}')"
[ "$GOT_SHA" = "$DRAFT_HASH" ] || fail "exported bytes sha256 $GOT_SHA != draft_hash $DRAFT_HASH"
grep -F '5. Proposed change, tested by Caveat:' "$DRAFT_FILE" >/dev/null \
  || fail "draft lacks '5. Proposed change, tested by Caveat:'"
note "{\"step\":\"e\",\"draft_sha256\":\"$GOT_SHA\",\"file\":\"caveat-draft-$RUN_ID-v1.txt\"}"

APPROVED_STATUS="$(db_query "SELECT status FROM runs WHERE id = '$RUN_ID'" | grep -o '"status":"[a-z_]*"' | cut -d'"' -f4)"
[ "$APPROVED_STATUS" = "approved" ] || fail "run status is $APPROVED_STATUS, want approved"

node -e '
  const fs = require("fs");
  const steps = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const rounds = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  fs.writeFileSync(process.argv[3], JSON.stringify({
    proof: "m6-search", ts: process.argv[4], outcome: "pass",
    runId: process.argv[5], search: rounds, steps,
  }, null, 2));
' "$RESULTS" "$EVIDENCE_DIR/search-rounds-$RUN_ID.json" "$SUMMARY" "$TS" "$RUN_ID"
rm -f "$EVIDENCE_DIR/.page-"*.html "$EVIDENCE_DIR/.proof-body"
echo "PROOF PASS: $SUMMARY"
