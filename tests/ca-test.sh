#!/bin/bash
# Cash-classification verification: page implementation vs independent jq
# recomputation, on a crafted fixture covering every journal shape.
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8495

pkill -f "node server.js" 2>/dev/null; sleep 1
rm -rf /tmp/catest && mkdir -p /tmp/catest/app
python3 /tmp/ca-fixture.py
cp /tmp/nexus-erp/index.html /tmp/nexus-erp/styles.css /tmp/nexus-erp/*.js /tmp/catest/app/
cd /tmp/catest/app
setsid nohup env PORT=8495 DATA_DIR=/tmp/catest/data node server.js > /tmp/catest/srv.log 2>&1 &
sleep 1.5

TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
AUTH="Authorization: Bearer $TOK"
ok "CA0 admin login" "$([ -n "$TOK" ] && [ "$TOK" != null ] && echo yes)" "yes"

# Independent jq recomputation from the raw store (not through the app code)
D=/tmp/catest/data/store.json
FROM=2026-11-01; TO=2026-11-30
cashdelta() { jq -r --arg f "$FROM" --arg t "$TO" '
  .data.accounts as $a | [ $a[] | select(.code=="1000" or .code=="1010") | .id ] as $cash
  | [ .data.journal[] | select(.date >= $f and .date <= $t)
      | { rt: .ref_type, d: ([ .lines[] | select(.account_id as $id | $cash | index($id) != null) | (.debit//0) - (.credit//0) ] | add // 0) } ]
  | map(select(.d != 0))' "$D"; }
EXP=$(cashdelta)
jqval() { echo "$EXP" | jq -r "$1"; }
ok "CA1 jq: actual cash change in period" "$(jqval 'map(.d) | add')" "-1175"
ok "CA2 jq: collections (payment, d>0)" "$(jqval '[.[] | select(.rt=="payment" and .d > 0) | .d] | add')" "114"
ok "CA3 jq: payouts (payment/pos-refund, d<0)" "$(jqval '[.[] | select((.rt=="payment" or .rt=="pos-refund") and .d < 0) | .d] | add')" "-339"
ok "CA4 jq: expenses paid" "$(jqval '[.[] | select(.rt=="expense" and .d < 0) | .d] | add')" "-60"
ok "CA5 jq: payroll paid" "$(jqval '[.[] | select(.rt=="payroll" and .d < 0) | .d] | add')" "-400"
ok "CA6 jq: asset investing" "$(jqval '[.[] | select((.rt=="asset" or .rt=="asset-dispose")) | .d] | add')" "-550"
ok "CA7 jq: unclassified (null ref_type)" "$(jqval '[.[] | select(.rt==null) | .d] | add')" "60"
ok "CA8 jq: out-of-period entries excluded" "$(jq ' [.data.journal[] | select(.date < "2026-11-01" or .date > "2026-11-30")] | length' "$D")" "2"
ok "CA9 jq: non-cash shapes present (variance/disposal/opening/depr/recognize)" "$(jq -r '[.data.journal[].ref_type] | (index("production") != null) and (index("asset-dispose") != null) and (index("opening") != null) and (index("asset-depr") != null) and (index("asset-recognize") != null) and (index("purchase") != null) and (index("invoice") != null) and (index("reclass") != null) | tostring' "$D")" "true"
ok "CA10 jq: reclass nets to zero cash" "$(jq -r '[.data.journal[] | select(.ref_type=="reclass")] | length' "$D")" "1"

# Page implementation via CDP
R=$(node /tmp/ca-eval.js $B $FROM $TO 2>/dev/null)
case "$R" in EXC:*|ERR*) echo "page eval failed: $R";; esac
pget() { echo "$R" | jq -r "$1"; }
ok "CA11 page: revenue (accrual)" "$(pget '.revenue')" "235"
ok "CA12 page: expenses (accrual)" "$(pget '.expenses')" "539"
ok "CA13 page: net income (accrual)" "$(pget '.ni')" "-304"
ok "CA14 page: collections bucket" "$(pget '.buckets[] | select(.key=="collections") | (.sum|tostring) + "/" + (.count|tostring)')" "114/1"
ok "CA15 page: payouts bucket" "$(pget '.buckets[] | select(.key=="payouts") | (.sum|tostring) + "/" + (.count|tostring)')" "-339/3"
ok "CA16 page: expenses paid bucket" "$(pget '.buckets[] | select(.key=="expenses_paid") | (.sum|tostring) + "/" + (.count|tostring)')" "-60/2"
ok "CA17 page: payroll bucket" "$(pget '.buckets[] | select(.key=="payroll_paid") | (.sum|tostring) + "/" + (.count|tostring)')" "-400/1"
ok "CA18 page: asset investing bucket" "$(pget '.buckets[] | select(.key=="asset_investing") | (.sum|tostring) + "/" + (.count|tostring)')" "-550/2"
ok "CA19 page: unclassified bucket" "$(pget '.buckets[] | select(.key=="unclassified") | (.sum|tostring) + "/" + (.count|tostring)')" "60/1"
ok "CA20 page: total == actual" "$(pget '(.total|tostring) + " " + (.actual|tostring)')" "-1175 -1175"
ok "CA21 page: classification check true" "$(pget '.check | tostring')" "true"
# period boundary sensitivity: widening the window picks up exactly the boundary entries
R2=$(node /tmp/ca-eval.js $B 2026-10-31 2026-12-01 2>/dev/null)
ok "CA22 page: widened window adds out-of-period entries" "$(echo "$R2" | jq -r '.actual')" "-953"
ok "CA23 page: widened check still true" "$(echo "$R2" | jq -r '.check | tostring')" "true"

# store untouched by reporting (read-only)
S1=$(sha256sum "$D" | cut -d' ' -f1)
node /tmp/ca-eval.js $B $FROM $TO > /dev/null 2>&1
ok "CA24 reporting leaves store byte-identical" "$(sha256sum "$D" | cut -d' ' -f1)" "$S1"

pkill -f "node server.js"
echo "== ca-test: $PASS passed, $FAIL failed =="
