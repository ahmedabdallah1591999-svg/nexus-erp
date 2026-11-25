#!/bin/bash
# Regression: pos-refund against the PRESERVED cumulative store that
# originally surfaced the stock/GL drift. Demonstrates the fixed op keeps
# GL1200 == stock-at-cost on that very data, with legacy rows (no
# pos_method / no payment method) settling to the historical cash account.
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }

pkill -f "node server.js" 2>/dev/null; sleep 1
rm -rf /tmp/preservetest && mkdir -p /tmp/preservetest/data /tmp/preservetest/app
cp /tmp/nexus-erp/index.html /tmp/nexus-erp/styles.css /tmp/nexus-erp/*.js /tmp/preservetest/app/
# legacy emulation: invoice 159 loses pos_method and its payment row loses method
jq '(.data.invoices[] | select(.id==159)) |= (del(.pos_method)) | (.data.payments[] | select(.ref_id==159)) |= (del(.method))' /tmp/rectest-store-preserved.json > /tmp/preservetest/data/store.json
cd /tmp/preservetest/app && setsid nohup env PORT=8499 DATA_DIR=/tmp/preservetest/data node server.js > /tmp/preservetest/srv.log 2>&1 &
sleep 1.5
B=http://localhost:8499
TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
AUTH="Authorization: Bearer $TOK"
ok "P0 admin login on preserved store" "$([ -n "$TOK" ] && [ "$TOK" != null ] && echo yes)" "yes"

AID() { curl -s $B/api/data -H "$AUTH" | jq -r '.data.accounts[] | select(.code=="'$1'").id'; }
SNAP() { curl -s $B/api/data -H "$AUTH" | jq -c '(.data.accounts[] | select(.code=="1200")) as $a | {inv_gl: ([.data.journal[].lines[] | select(.account_id==$a.id) | (.debit//0)-(.credit//0)] | add), stock_val: ([.data.products[] | .stock * .cost] | add), journal: (.data.journal | length), has1010: ([.data.accounts[] | select(.code=="1010")] | length)}'; }
SNAP > /tmp/preserve-before.json
ok "P1 gap 0 before" "$(jq -r '.inv_gl - .stock_val' /tmp/preserve-before.json)" "0"
ok "P1b 1010 added by COA migration on load" "$(jq -r '.has1010' /tmp/preserve-before.json)" "1"

# the original failing op: full refund of a paid POS sale on this store
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":159}')
ok "P2 legacy refund (no pos_method) succeeds" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
D=$(curl -s $B/api/data -H "$AUTH")
CASH=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="1000").id')
VAT=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="2100").id')
RJ=$(echo "$D" | jq '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id==159)][0]')
ok "P3 refund journal balanced" "$(echo "$RJ" | jq -r '([.lines[].debit] | add) == ([.lines[].credit] | add) | tostring')" "true"
ok "P4 legacy no-method refund credits 1000 (historical cash)" "$(echo "$RJ" | jq -r --arg c "$CASH" '([.lines[] | select(.credit==25 and .account_id==($c|tonumber))] | length | tostring)')" "1"
ok "P5 no VAT leg on untaxed legacy sale" "$(echo "$RJ" | jq -r --arg v "$VAT" '([.lines[] | select(.account_id==($v|tonumber))] | length | tostring)')" "0"
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":133}')
ok "P6 second cash refund (INV-0059 100)" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
ok "P7 exactly-once" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":159}')" "400"
# ambiguous legacy: transfer sale booked to cash (pre-fix) — refund must
# BLOCK until an admin reviews the settlement reclass
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":166}')
ok "P11 ambiguous legacy refund blocked 400" "$(echo "$R" | jq -r 'if .error then "400" else "got-ok" end')" "400"
ok "P11b block message names the reclass review" "$(echo "$R" | jq -r '.error' | grep -ci 'reclass' | sed 's/^1$/yes/')" "yes"
# admin reviews and approves the reclass: dated Dr1010/Cr1000, originals kept
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"reclass-settlement","all":true}')
ok "P12 reclass posts exactly the one legacy mismatch" "$(echo "$R" | jq -r '(.posted | tostring) + " " + (.total | tostring)')" "1 25"
D=$(curl -s $B/api/data -H "$AUTH")
CASH=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="1000").id')
BANK=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="1010").id')
ok "P12b reclass entry Dr1010/Cr1000 25" "$(echo "$D" | jq -r --arg b "$BANK" --arg c "$CASH" '[.data.journal[] | select(.ref_type=="reclass")][0] | ([.lines[] | select(.debit==25 and .account_id==($b|tonumber))] | length | tostring) + " " + ([.lines[] | select(.credit==25 and .account_id==($c|tonumber))] | length | tostring)')" "1 1"
ok "P12c original payment journal untouched (still Dr1000)" "$(echo "$D" | jq -r --arg c "$CASH" '[.data.payments[] | select(.ref_id==166 and .direction=="in")][0].journal_id as $j | [.data.journal[] | select(.id==$j)][0] | ([.lines[] | select(.debit==25 and .account_id==($c|tonumber))] | length | tostring)')" "1"
ok "P12d payment flagged reclassed (audit)" "$(echo "$D" | jq -r '[.data.payments[] | select(.ref_id==166 and .direction=="in")][0].reclassed')" "true"
ok "P12e reclass exactly-once" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"reclass-settlement","all":true}')" "400"
# now the refund proceeds: actual payout via transfer leaves the bank
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":166}')
ok "P13 refund after reclass succeeds" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
D=$(curl -s $B/api/data -H "$AUTH")
ok "P13b refund credits 1010 (actual payout)" "$(echo "$D" | jq -r --arg b "$BANK" '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id==166)][0] | ([.lines[] | select(.credit==25 and .account_id==($b|tonumber))] | length | tostring)')" "1"
SNAP > /tmp/preserve-after.json
ok "P8 gap still 0 after refunds" "$(jq -r '.inv_gl - .stock_val' /tmp/preserve-after.json)" "0"

# restart durability on the preserved store
pkill -f "node server.js"; sleep 1
cd /tmp/preservetest/app && setsid nohup env PORT=8499 DATA_DIR=/tmp/preservetest/data node server.js > /tmp/preservetest/srv2.log 2>&1 &
sleep 1.5
TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
AUTH="Authorization: Bearer $TOK"
ok "P9 restart: all refunds persist" "$(curl -s $B/api/data -H "$AUTH" | jq '[.data.invoices[] | select(.status=="refunded")] | length')" "3"
ok "P10 gap 0 after restart" "$(curl -s $B/api/data -H "$AUTH" | jq -r '(.data.accounts[] | select(.code=="1200")) as $a | ([.data.journal[].lines[] | select(.account_id==$a.id) | (.debit//0)-(.credit//0)] | add) - ([.data.products[] | .stock * .cost] | add)')" "0"
pkill -f "node server.js"
echo "== preserve-test: $PASS passed, $FAIL failed =="
