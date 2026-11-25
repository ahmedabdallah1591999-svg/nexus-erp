#!/bin/bash
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8499; D=/tmp/p2ptest; H='Content-Type: application/json'
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8499 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"boss\",\"password\":\"b0ss-pass-1\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"boss","password":"b0ss-pass-1"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
d(){ curl -s $B/api/data -H "$A" | jq -c "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"S1"},{"id":778,"name":"S2"}]}}'
SID=777
PID=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":0}}' | jq .product.id)
ITEMS='[{"product_id":'$PID',"qty":10,"cost":10}]'
R=$(tx '{"op":"purchase-save","out":{"status":"draft","items":'$ITEMS',"number":"PO-9999","stock_applied":true,"journal_received":true,"ledger_posted":true}}'); POID=$(echo $R | jq .purchase.id)
ok "T1 new PO number server-assigned, forged flags ignored" "$(echo $R | jq -r '.purchase.number+","+(.purchase.stock_applied|tostring)+","+((.purchase.journal_received//false)|tostring)')" "PO-0001,false,false"
ok "T2 draft has no stock/journal effect" "$(d '(.data.products[0].stock|tostring)+","+(.data.journal|length|tostring)')" '"0,0"'
ok "T3 draft->ordered allowed" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"ordered","items":'$ITEMS'}}' | jq -r .purchase.status)" "ordered"
ok "T4 ordered->draft allowed" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"draft","items":'$ITEMS'}}' | jq -r .purchase.status)" "draft"
ok "T5 unknown supplier rejected" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"draft","supplier_id":9999,"items":'$ITEMS'}}' | jq -r .error)" "supplier not found"
R6=$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":'$SID',"items":'$ITEMS'}}'); echo "T6raw $R6" | head -c 300; echo; ok "T6 receive posts once" "$(echo $R6 | jq -r .purchase.stock_applied)" "true"
SNAP='[.data.products[0].stock,(.data.journal|length),(.data.ledger|length),(.data.stock_moves|length)]'
S0=$(d "$SNAP")
ok "T7 stock 10, one journal, one ledger" "$S0" "[10,1,1,1]"
tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":'$SID',"items":'$ITEMS',"stock_applied":false,"journal_received":false,"ledger_posted":false}}' >/dev/null
ok "T8 forged flags on received PO cannot double-post" "$(d "$SNAP")" "$S0"
ok "T9 received qty change rejected" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":'$SID',"items":[{"product_id":'$PID',"qty":100,"cost":10}]}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "T10 received cost change rejected" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":'$SID',"items":[{"product_id":'$PID',"qty":10,"cost":1}]}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "T11 received->draft rejected" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"draft","supplier_id":'$SID',"items":'$ITEMS'}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "T12 received supplier swap rejected" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":778,"items":'$ITEMS'}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "T13 note edit on received allowed" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","supplier_id":'$SID',"items":'$ITEMS',"notes":"invoice 123 seen"}}' | jq -r .purchase.notes)" "invoice 123 seen"
ok "T14 number unchanged after attempted forge" "$(tx '{"op":"purchase-save","id":'$POID',"out":{"status":"received","number":"PO-0777","supplier_id":'$SID',"items":'$ITEMS'}}' | jq -r .purchase.number)" "PO-0001"
ok "T15 books unchanged after all attempts" "$(d "$SNAP")" "$S0"
pkill -f "node server.js"
echo "purchase-test: PASS=$PASS FAIL=$FAIL"
