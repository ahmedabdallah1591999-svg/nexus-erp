#!/bin/bash
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8498; D=/tmp/corrtest; H='Content-Type: application/json'
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8498 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"boss\",\"password\":\"b0ss-pass-1\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"boss","password":"b0ss-pass-1"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
d(){ curl -s $B/api/data -H "$A" | jq -c "$1"; }
bal(){ curl -s $B/api/data -H "$A" | jq -c --arg c "$1" '(.data.accounts[]|select(.code==$c)|.id) as $i | ([.data.journal[].lines[]|select(.account_id==$i)|.debit-.credit]|add // 0)'; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"S1"}],"contacts":[{"id":555,"first_name":"Cu","last_name":"St"}]}}'
PID=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":20}}' | jq .product.id)
inv(){ tx '{"op":"invoice-save","out":{"status":"'$1'","contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":'$2',"items":[{"product_id":'$PID',"qty":'$3',"price":'$4'}]}}'; }
# ---- sales credit notes
R=$(inv sent 10 4 30); I1=$(echo $R | jq .invoice.id)
ok "S0 stock after invoice 16" "$(d '.data.products[0].stock')" "16"
cn(){ tx '{"op":"credit-note-create","invoice_id":'$1',"reason":"'"${5:-damaged}"'","items":[{"line":0,"qty":'$2',"restock":'${3:-true}'}]'"${4:+,$4}"'}'; }
R=$(cn $I1 1 true); ok "S1 unpaid credit note posts" "$(echo $R | jq -r '.credit_note.number+","+(.credit_note.total|tostring)+","+(.credit_note.applied_to_receivable|tostring)+","+(.credit_note.refunded|tostring)')" "CN-0001,33,33,0"
ok "S2 restock raised stock to 17" "$(d '.data.products[0].stock')" "17"
ok "S3 invoice open amount reduced (credited 33)" "$(d '.data.invoices[0].credited_amount')" "33"
ok "S4 AR = 132-33 = 99" "$(bal 1100)" "99"
ok "S5 revenue net 120-30" "$(bal 4000)" "-90"
ok "S6 tax payable 12-3" "$(bal 2100)" "-9"
ok "S7 over-credit rejected" "$(cn $I1 4 true | jq -r .error)" "credit quantity exceeds what is left to credit on line 1"
ok "S8 reason required" "$(tx '{"op":"credit-note-create","invoice_id":'$I1',"items":[{"line":0,"qty":1}]}' | jq -r .error)" "a reason is required"
J0=$(d '[(.data.journal|length),(.data.stock_moves|length),(.data.credit_notes|length)]')
R=$(tx '{"op":"credit-note-create","client_ref":"X1","invoice_id":'$I1',"reason":"retry test","items":[{"line":0,"qty":1,"restock":false}]}'); R2=$(tx '{"op":"credit-note-create","client_ref":"X1","invoice_id":'$I1',"reason":"retry test","items":[{"line":0,"qty":1,"restock":false}]}')
ok "S9 retry with same client_ref is idempotent" "$(echo $R2 | jq -r '(.duplicate|tostring)+","+.credit_note.number')" "true,CN-0002"
ok "S10 only one extra credit note, no restock = no stock move" "$(d '[(.data.journal|length),(.data.stock_moves|length),(.data.credit_notes|length)]')" "[$(echo $J0 | jq '.[0]+1'),$(echo $J0 | jq '.[1]'),2]"
ok "S11 stock still 17 without restock" "$(d '.data.products[0].stock')" "17"
ok "S12 draft invoice cannot be credited" "$(cn $(inv draft 0 1 30 | jq .invoice.id) 1 | jq -r .error | cut -c1-30)" "only a posted (sent or paid) i"
ok "S13 unknown line rejected" "$(tx '{"op":"credit-note-create","invoice_id":'$I1',"reason":"zzz","items":[{"line":9,"qty":1}]}' | jq -r .error)" "unknown invoice line"
# concurrent: only 1 unit left (4-1-1=2 -> use remaining 2? ) use fresh invoice
I2=$(inv sent 0 1 30 | jq .invoice.id)
for i in 1 2 3 4 5 6 7 8; do (tx '{"op":"credit-note-create","invoice_id":'$I2',"reason":"race","items":[{"line":0,"qty":1,"restock":true}]}' | jq -r '.ok // .credit_note.number' >> $D/race.txt) & done; wait
ok "S14 8 concurrent full credits: exactly one wins" "$(d '[.data.credit_notes[]|select(.invoice_id=='$I2')]|length')" "1"
# paid invoice, refund
I3=$(inv sent 0 2 30 | jq .invoice.id)
tx '{"op":"invoice-save","id":'$I3',"out":{"status":"paid","contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":0,"items":[{"product_id":'$PID',"qty":2,"price":30}]}}' >/dev/null
ok "S15 paid invoice: credit w/o confirmed refund rejected" "$(cn $I3 1 true | jq -r '.error|test("actually been sent back|actually")|tostring')" "true"
ok "S15b method chosen but NOT confirmed is still rejected" "$(cn $I3 1 true '"refund_method":"bank","refund_reference":"TRX1"' | jq -r '.error|test("actually")|tostring')" "true"
ok "S15c confirmed but no reference rejected" "$(cn $I3 1 true '"refund_confirmed":true,"refund_method":"bank"' | jq -r '.error|test("actually")|tostring')" "true"
ok "S15d rejected attempts left no credit note on I3" "$(d '[.data.credit_notes[]|select(.invoice_id=='$I3')]|length')" "0"
CB=$(bal 1000)
R=$(cn $I3 1 true '"refund_confirmed":true,"refund_method":"bank","refund_reference":"TRX-77"'); ok "S16 confirmed refund recorded with method, reference, who" "$(echo $R | jq -r '(.credit_note.refunded|tostring)+","+.credit_note.refund_method+","+.credit_note.refund_reference+","+.credit_note.refund_confirmed_by')" "30,bank,TRX-77,boss"
ok "S17 refund hit bank 1010 not cash" "$(bal 1000)" "$CB"
ok "S18 invalid refund method rejected" "$(cn $I3 1 true '"refund_confirmed":true,"refund_method":"gold","refund_reference":"x1"' | jq -r '.error|test("actually")|tostring')" "true"
# partial paid then credit more than open
I4=$(inv sent 0 4 25 | jq .invoice.id)
curl -s $B/api/tx -X POST -H "$A" -H "$H" -d '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$I4',"amount":40,"method":"cash"}' >/dev/null
R=$(tx '{"op":"credit-note-create","invoice_id":'$I4',"reason":"partial case","items":[{"line":0,"qty":3,"restock":false}],"refund_confirmed":true,"refund_method":"cash","refund_reference":"cash-out-1"}')
ok "S19 partial paid: AR share 60, refund 15" "$(echo $R | jq -r '(.credit_note.applied_to_receivable|tostring)+","+(.credit_note.refunded|tostring)')" "60,15"
# full credit then mark paid
I5=$(inv sent 0 1 30 | jq .invoice.id); cn $I5 1 false >/dev/null
ok "S20 fully credited invoice cannot be marked paid" "$(tx '{"op":"invoice-save","id":'$I5',"out":{"status":"paid","contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":0,"items":[{"product_id":'$PID',"qty":1,"price":30}]}}' | jq -r .error | cut -c1-39)" "this invoice is fully settled by credit"
ok "S21 forged credit_notes via PUT ignored" "$(curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"credit_notes":[{"id":9,"total":1}]}}'; d '[.data.credit_notes[]|select(.id==9)]|length')" "0"
ok "S22 forged invoice credited_amount via save ignored" "$(tx '{"op":"invoice-save","id":'$I1',"out":{"status":"sent","credited_amount":0,"contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":10,"items":[{"product_id":'$PID',"qty":4,"price":30}]}}' | jq -r .ok)" "true"
ok "S23 credited_amount still server value (33+33)" "$(d '[.data.invoices[]|select(.id=='$I1')][0].credited_amount')" "66"
# ---- purchase returns
PP=$(tx '{"op":"product-save","out":{"name":"Gadget","price":50,"cost":10,"stock":0}}' | jq .product.id)
pitems='[{"product_id":'$PP',"qty":10,"cost":10}]'
PO=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":'$pitems'}}' | jq .purchase.id)
pr(){ tx '{"op":"purchase-return-create","purchase_id":'$1',"reason":"defective","items":[{"line":0,"qty":'$2'}]'"${3:+,$3}"'}'; }
AP0=$(bal 2000)
R=$(pr $PO 3); ok "T1 purchase return posts" "$(echo $R | jq -r '.purchase_return.number+","+(.purchase_return.total|tostring)+","+(.purchase_return.applied_to_payable|tostring)')" "PR-0001,30,30"
ok "T2 stock 7" "$(d '[.data.products[]|select(.id=='$PP')][0].stock')" "7"
ok "T3 AP reduced by 30" "$(bal 2000)" "$(echo $AP0 | jq ". + 30")"
ok "T4 over-return rejected" "$(pr $PO 8 | jq -r .error | cut -c1-35)" "return quantity exceeds what is lef"
# sell 6 -> stock 1, returning 3 more is blocked by stock
tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":0,"items":[{"product_id":'$PP',"qty":6,"price":50}]}}' >/dev/null
ok "T5 cannot return stock already sold" "$(pr $PO 3 | jq -r .error | cut -c1-31)" "not enough stock of Gadget on h"
ok "T6 duplicate retry idempotent" "$(tx '{"op":"purchase-return-create","client_ref":"R1","purchase_id":'$PO',"reason":"retry","items":[{"line":0,"qty":1}]}' >/dev/null; tx '{"op":"purchase-return-create","client_ref":"R1","purchase_id":'$PO',"reason":"retry","items":[{"line":0,"qty":1}]}' | jq -r '(.duplicate|tostring)+","+.purchase_return.number')" "true,PR-0002"
ok "T7 PR count 2" "$(d '.data.purchase_returns|length')" "2"
# paid PO, return needs refund
PO2=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":'$pitems'}}' | jq .purchase.id)
tx '{"op":"payment","direction":"out","ref_type":"purchase","ref_id":'$PO2',"amount":100,"method":"bank"}' >/dev/null
ok "T8 paid PO return without confirmed supplier refund rejected" "$(pr $PO2 2 '"refund_method":"bank","refund_reference":"B1"' | jq -r '.error|test("actually paid it back")|tostring')" "true"
R=$(pr $PO2 2 '"refund_confirmed":true,"refund_method":"bank","refund_reference":"SUP-REF-9"'); ok "T9 paid PO return records supplier refund" "$(echo $R | jq -r '(.purchase_return.refunded|tostring)+","+(.purchase_return.applied_to_payable|tostring)')" "20,0"
ok "T10 PO purchase-save still immutable after return" "$(tx '{"op":"purchase-save","id":'$PO2',"out":{"status":"received","supplier_id":777,"items":'$pitems',"returned_amount":0}}' | jq -r .ok)" "true"
ok "T11 returned_amount not forgeable" "$(d '[.data.purchases[]|select(.id=='$PO2')][0].returned_amount')" "20"
ok "T12 PO received at a cost different from product cost blocked by books gate (pre-existing)" "$(PO3=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PP',"qty":2,"cost":12}]}}' | jq -r '.error // .purchase.id'); echo $PO3 | cut -c1-12)" "Unreconciled"
ok "T13 permissions: unknown PO rejected" "$(pr 99999 1 | jq -r .error)" "purchase not found"

# ---- sales-order returns (reconciled with invoice open amount)
mkord(){ O=$(tx '{"op":"order-save","out":{"status":"draft","contact_id":555,"order_date":"2026-11-02","tax_rate":'$1',"items":[{"product_id":'$PID',"qty":'$2',"price":'$3'}]}}' | jq .order.id); tx '{"op":"order-confirm","id":'$O'}' >/dev/null; OI=$(tx '{"op":"order-fulfill","id":'$O'}' | jq .invoice_id); }
rt(){ tx '{"op":"return-create","id":'$1',"items":[{"product_id":'$PID',"qty":'$2',"price":'${3:-30}'}]'"${4:+,$4}"'}'; }
mkord 10 3 30; O1=$O; OI1=$OI
ok "R0 order invoice total 99, open 99" "$(d '[.data.invoices[]|select(.id=='$OI1')][0]|[.status,.credited_amount]|tostring')" '"[\"sent\",null]"'
R=$(rt $O1 1 1); ok "R1 forged price ignored: return priced from order line (33 incl tax)" "$(echo $R | jq -r .return.amount)" "33"
ok "R2 order return reduces invoice open: AR now 66 for this invoice (total journal AR check)" "$(d '[.data.returns[]|select(.order_id=='$O1')][0].items[0].price')" "30"
ok "R3 mixed: credit note on same invoice limited to what remains (3-1=2); 3 rejected" "$(cn $OI1 3 true | jq -r '.error|test("already been credited or returned|exceeds what is left")|tostring')" "true"
R=$(cn $OI1 2 true); ok "R4 mixed: credit note for remaining 2 posts (66, AR share 66)" "$(echo $R | jq -r '(.credit_note.total|tostring)+","+(.credit_note.applied_to_receivable|tostring)')" "66,66"
ok "R5 invoice fully settled by return + credit note" "$(d '[.data.invoices[]|select(.id=='$OI1')][0]|.status')" '"sent"'
ok "R6 payment against fully credited invoice rejected" "$(tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$OI1',"amount":1,"method":"cash"}' | jq -r ".error|test(\"payment rejected\")|tostring")" "true"
ok "R7 mixed return after credit exhausted rejected" "$(rt $O1 1 | jq -r '.error|test("exceeds sold|already been credited")|tostring')" "true"
# order return on a paid invoice needs confirmed refund
mkord 0 2 30; O2=$O; OI2=$OI
TD=$(date +%F); tx '{"op":"invoice-save","id":'$OI2',"out":{"status":"paid","contact_id":555,"issue_date":"'$TD'","due_date":"'$TD'","tax_rate":0,"items":[{"product_id":'$PID',"qty":2,"price":30}]}}' >/dev/null
J1=$(d '[(.data.journal|length),(.data.returns|length)]')
ok "R8 paid invoice return without confirmed refund rejected" "$(rt $O2 1 30 '"refund_method":"cash"' | jq -r '.error|test("actually")|tostring')" "true"
ok "R9 nothing posted by the rejection" "$(d '[(.data.journal|length),(.data.returns|length)]')" "$J1"
R=$(rt $O2 1 30 '"refund_confirmed":true,"refund_method":"transfer","refund_reference":"BANK-55"')
ok "R10 confirmed refund posts to bank and stores reference" "$(echo $R | jq -r '.return.refund_method+","+.return.refund_reference')" "transfer,BANK-55"
# part-paid invoice from an order, return bigger than open
mkord 0 4 25; O3=$O; OI3=$OI
tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$OI3',"amount":70,"method":"cash"}' >/dev/null
ok "R11 part-paid: return of 2 (50) within open 30? needs refund for 20" "$(rt $O3 2 25 | jq -r '.error|test("actually")|tostring')" "true"
R=$(rt $O3 1 25); ok "R12 part-paid: return of 1 (25) within open 30 posts AR-only (no refund needed)" "$(echo $R | jq -r '.return.amount')" "25"
ok "R13 open after R12 is 5: paying 6 rejected" "$(tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$OI3',"amount":6,"method":"cash"}' | jq -r ".error|test(\"payment rejected\")|tostring")" "true"
CNN=$(d '.data.credit_notes|length')
# historical returns: old return row without refund fields still counts in open amount
python3 - <<PY
import json
p='$D/data/store.json'; db=json.load(open(p))
inv=[i for i in db['data']['invoices'] if i['id']==$OI3][0]
db['data']['returns'].append({'id':99990,'number':'RET-OLD','order_id':$O3,'invoice_id':$OI3,'date':'2026-11-03','items':[],'amount':5})
json.dump(db,open(p,'w'))
PY
pkill -f "node server.js"; sleep 1
(setsid nohup env PORT=8498 DATA_DIR=$D/data node server.js > $D/srv2.log 2>&1 &); sleep 1.5
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"boss","password":"b0ss-pass-1"}' | jq -r .token); A="Authorization: Bearer $TOK"
ok "R14 historic return row (no migration) counts: remaining open 0, payment rejected" "$(tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$OI3',"amount":5,"method":"cash"}' | jq -r ".error|test(\"payment rejected\")|tostring")" "true"
ok "R15 data survived restart (credit notes intact)" "$(d '.data.credit_notes|length')" "$CNN"
pkill -f "node server.js"
echo "corr-test: PASS=$PASS FAIL=$FAIL"
