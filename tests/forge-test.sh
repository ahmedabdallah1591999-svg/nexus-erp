#!/bin/bash
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8499; D=/tmp/frgtest; H='Content-Type: application/json'
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8499 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"boss\",\"password\":\"b0ss-pass-1\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"boss","password":"b0ss-pass-1"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"contacts":[{"id":901,"first_name":"C"}]}}'
# product
R=$(tx '{"op":"product-save","out":{"id":5,"name":"P1","price":5,"cost":2,"bom":[{"product_id":123,"qty":1}]}}'); PID=$(echo $R | jq .product.id)
ok "F1 product create ignores forged id and bom" "$(echo $R | jq -c '[(.product.id!=5), (.product.bom//null)]')" "[true,null]"
R=$(tx '{"op":"product-save","id":'$PID',"out":{"id":1,"name":"P1b","price":5,"cost":2,"bom":[{"product_id":'$PID',"qty":1}]}}')
ok "F2 product edit keeps id, ignores bom" "$(echo $R | jq -c '[(.product.id=='$PID'), (.product.bom//null), .product.name]')" '[true,null,"P1b"]'
# quote
R=$(tx '{"op":"quote-save","out":{"status":"draft","number":"Q-9999","invoiced_invoice_id":77,"order_id":88,"contact_id":901,"items":[{"qty":1,"price":10}]}}'); QID=$(echo $R | jq .quote.id)
ok "F3 quote create ignores number/links" "$(echo $R | jq -c '[.quote.number,(.quote.invoiced_invoice_id//null),(.quote.order_id//null)]')" '["Q-0001",null,null]'
R=$(tx '{"op":"quote-save","id":'$QID',"out":{"status":"sent","number":"Q-5","invoiced_invoice_id":77,"items":[{"qty":2,"price":10}]}}')
ok "F4 quote edit cannot self-lock or renumber" "$(echo $R | jq -c '[.quote.number,(.quote.invoiced_invoice_id//null),.quote.status]')" '["Q-0001",null,"sent"]'
# order
R=$(tx '{"op":"order-save","out":{"status":"draft","number":"SO-9999","invoice_id":55,"quote_id":66,"fulfilled_date":"2026-01-01","contact_id":901,"items":[{"qty":1,"price":10}]}}'); OID=$(echo $R | jq .order.id)
ok "F5 order create ignores number/links/fulfilled" "$(echo $R | jq -c '[.order.number,(.order.invoice_id//null),(.order.quote_id//null),(.order.fulfilled_date//null)]')" '["SO-0001",null,null,null]'
R=$(tx '{"op":"order-save","id":'$OID',"out":{"status":"draft","invoice_id":55,"fulfilled_date":"2026-01-01","items":[{"qty":3,"price":10}]}}')
ok "F6 order edit ignores forged invoice/fulfilled" "$(echo $R | jq -c '[(.order.invoice_id//null),(.order.fulfilled_date//null),.order.items[0].qty]')" '[null,null,3]'
# recurring
R=$(tx '{"op":"recurring-save","out":{"interval":"monthly","contact_id":901,"next_date":"2026-12-01","last_invoice_id":42,"items":[{"qty":1,"price":10}]}}'); RID=$(echo $R | jq .recurring.id)
ok "F7 recurring create ignores last_invoice_id" "$(echo $R | jq -c '.recurring.last_invoice_id')" "null"
R=$(tx '{"op":"recurring-save","id":'$RID',"out":{"interval":"monthly","contact_id":901,"next_date":"2026-12-01","last_invoice_id":42,"items":[{"qty":1,"price":10}]}}')
ok "F8 recurring edit ignores last_invoice_id" "$(echo $R | jq -c '.recurring.last_invoice_id')" "null"

# ---- invoices: forged flags, posted-lock, status rules, status-only paid
PID2=$(tx '{"op":"product-save","out":{"name":"W2","price":30,"cost":10}}' | jq .product.id)
tx '{"op":"purchase-save","out":{"status":"received","items":[{"product_id":'$PID2',"qty":50,"cost":10}]}}' >/dev/null
d(){ curl -s $B/api/data -H "$A" | jq -c "$1"; }
SNAP='[(.data.products[]|select(.id=='$PID2')|.stock),(.data.journal|length),(.data.ledger|length),(.data.stock_moves|length)]'
IT='[{"product_id":'$PID2',"qty":5,"price":30}]'
R=$(tx '{"op":"invoice-save","out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT',"number":"INV-777"}}'); IID=$(echo $R | jq .invoice.id)
ok "I1 invoice number server-assigned" "$(echo $R | jq -r .invoice.number | grep -c '^INV-777$')" "0"
S0=$(d "$SNAP")
tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT',"stock_applied":false,"journal_sent":false,"journal_cogs":false,"ledger_posted":false}}' >/dev/null
ok "I2 forged flags cannot double-deduct stock or double-post" "$(d "$SNAP")" "$S0"
ok "I3 posted invoice qty change rejected" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":[{"product_id":'$PID2',"qty":40,"price":30}]}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "I4 posted invoice price change rejected" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":[{"product_id":'$PID2',"qty":5,"price":1}]}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "I5 posted invoice tax change rejected" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":50,"items":'$IT'}}' | jq -r '.error|test("cannot be changed")|tostring')" "true"
ok "I6 sent->draft rejected" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"draft","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' | jq -r '.error|test("earlier status")|tostring')" "true"
ok "I7 books unchanged after rejected attempts" "$(d "$SNAP")" "$S0"
ok "I8 notes edit on posted invoice allowed" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT',"notes":"PO ref 55"}}' | jq -r .invoice.notes)" "PO ref 55"
ok "I9 sent->paid allowed and books consistent (no error)" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"paid","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' | jq -r '.error//"ok"')" "ok"
ok "I10 paid->sent rejected" "$(tx '{"op":"invoice-save","id":'$IID',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' | jq -r '.error|test("earlier status")|tostring')" "true"
ok "I11 unknown customer rejected" "$(tx '{"op":"invoice-save","out":{"status":"draft","contact_id":99999,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' | jq -r .error)" "customer not found"
# retry/duplicate safety: identical re-send of the paid save changes nothing
S1=$(d "$SNAP")
for i in 1 2 3; do tx '{"op":"invoice-save","id":'$IID',"out":{"status":"paid","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' >/dev/null; done
ok "I12 retried identical save is idempotent" "$(d "$SNAP")" "$S1"
# concurrency: 20 parallel receives of one PO and 20 parallel sends of one draft invoice
R=$(tx '{"op":"purchase-save","out":{"status":"draft","items":[{"product_id":'$PID2',"qty":7,"cost":10}]}}'); P2=$(echo $R | jq .purchase.id)
B0=$(d '[.data.products[]|select(.id=='$PID2')|.stock][0]')
for i in $(seq 20); do tx '{"op":"purchase-save","id":'$P2',"out":{"status":"received","items":[{"product_id":'$PID2',"qty":7,"cost":10}]}}' >/dev/null & done; wait
ok "C1 20 parallel receives apply stock once (+7)" "$(d '[.data.products[]|select(.id=='$PID2')|.stock][0]')" "$((B0+7))"
ok "C2 exactly one payables journal for that PO" "$(d '[.data.journal[]|select(.ref_type=="purchase" and .ref_id=='$P2')]|length')" "1"
R=$(tx '{"op":"invoice-save","out":{"status":"draft","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}'); I2=$(echo $R | jq .invoice.id)
B1=$(d '[.data.products[]|select(.id=='$PID2')|.stock][0]')
for i in $(seq 20); do tx '{"op":"invoice-save","id":'$I2',"out":{"status":"sent","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":'$IT'}}' >/dev/null & done; wait
ok "C3 20 parallel sends deduct stock once (-5)" "$(d '[.data.products[]|select(.id=='$PID2')|.stock][0]')" "$((B1-5))"
ok "C4 exactly one sent-journal for that invoice" "$(d '[.data.journal[]|select(.ref_type=="invoice" and .ref_id=='$I2')]|length')" "1"
# product cost change with stock on hand cannot desync valuation from the books
SC0=$(d "$SNAP")
ok "C5 product cost change with stock on hand rejected, nothing committed" "$(tx '{"op":"product-save","id":'$PID2',"out":{"name":"W2","price":30,"cost":99}}' | jq -r '.error|test("not supported")|tostring')" "true"
ok "C6 rejected cost change left books identical" "$(d "$SNAP")" "$SC0"
ok "C7 product price (not cost) change allowed" "$(tx '{"op":"product-save","id":'$PID2',"out":{"name":"W2","price":45,"cost":10}}' | jq -r .product.price)" "45"

# ---- generic junk-field fuzz on remaining create/save ops: no junk key, forged id or author may persist
JUNK='"zz_forged":1,"created_by":"mallory","submitted_by":"mallory","reviewed_by":"mallory","owner":"mallory","approved_by":"mallory","stock_applied":true,"journal_sent":true,"ledger_posted":true,"number":"X-9999"'
EMP=$(curl -s $B/api/data -H "$A" | jq '.data.employees[0].id // empty')
if [ -z "$EMP" ]; then curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"employees":[{"id":950,"name":"E","status":"active","salary":1000}]}}'; EMP=950; fi
chk(){ # name op-json collection
  R=$(tx "$2"); ROW=$(curl -s $B/api/data -H "$A" | jq -c "[.data.$3[]|select(.zz_forged!=null or .id==4242 or .created_by==\"mallory\" or .submitted_by==\"mallory\" or .reviewed_by==\"mallory\" or .owner==\"mallory\" or .approved_by==\"mallory\" or .number==\"X-9999\")]|length")
  ok "J $1 saved ($(echo $R | jq -r 'if .error then "err:"+.error else "ok" end' | cut -c1-40)), no junk persisted" "$ROW" "0"
}
chk project-save '{"op":"project-save","out":{"name":"PJ","contact_id":901,"hourly_rate":50,"budget_hours":40,'"$JUNK"'}}' projects
PJ=$(curl -s $B/api/data -H "$A" | jq '.data.projects[0].id')
chk timesheet-save '{"op":"timesheet-save","out":{"project_id":'$PJ',"date":"2026-11-25","hours":2,"description":"x","billable":true,'"$JUNK"'}}' timesheets
chk ticket-save '{"op":"ticket-save","out":{"subject":"T","priority":"low",'"$JUNK"'}}' tickets
chk expense-save '{"op":"expense-save","out":{"amount":5,"category":"Travel",'"$JUNK"'}}' expenses
chk leave-save '{"op":"leave-save","out":{"employee_id":'$EMP',"type":"annual","from_date":"2026-12-01","to_date":"2026-12-02","reason":"r",'"$JUNK"'}}' leave_requests
chk attendance-save '{"op":"attendance-save","out":{"employee_id":'$EMP',"date":"2026-11-25","check_in":"09:00","check_out":"17:00",'"$JUNK"'}}' attendance
chk asset-save '{"op":"asset-save","out":{"name":"A","purchase_date":"2026-11-01","cost":100,"salvage":0,"life_months":12,'"$JUNK"'}}' assets
chk qc-save '{"op":"qc-save","out":{"title":"Q","qty_inspected":1,'"$JUNK"'}}' quality_checks
chk doc-save '{"op":"doc-save","out":{"title":"D",'"$JUNK"'}}' documents
chk warehouse-add '{"op":"warehouse-add","name":"WH","location":"x",'"$JUNK"'}' warehouses

chk product-save '{"op":"product-save","out":{"name":"JP","price":1,"cost":1,'"$JUNK"'}}' products
chk quote-save '{"op":"quote-save","out":{"status":"draft","contact_id":901,"items":[{"qty":1,"price":1}],'"$JUNK"'}}' quotes
chk order-save '{"op":"order-save","out":{"status":"draft","contact_id":901,"tax_rate":0,"items":[{"qty":1,"price":1}],'"$JUNK"'}}' sales_orders
chk recurring-save '{"op":"recurring-save","out":{"interval":"monthly","contact_id":901,"next_date":"2026-12-01","tax_rate":0,"items":[{"qty":1,"price":1}],'"$JUNK"'}}' recurring
chk purchase-save '{"op":"purchase-save","out":{"status":"draft","items":[{"qty":1,"cost":1}],'"$JUNK"'}}' purchases
chk invoice-save '{"op":"invoice-save","out":{"status":"draft","contact_id":901,"issue_date":"2026-11-25","tax_rate":0,"items":[{"qty":1,"price":1}],'"$JUNK"'}}' invoices
pkill -f "node server.js"
echo "forge-test: PASS=$PASS FAIL=$FAIL"
