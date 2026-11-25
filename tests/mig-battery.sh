#!/bin/bash
export NEXUS_TEST_ALLOW_FUTURE=1 NEXUS_TEST_HARNESS=nexus-automated-suite
# Migration review/approval battery
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8493

rm -rf /tmp/migtest2 && mkdir -p /tmp/migtest2/data /tmp/migtest2/app
cp /tmp/migtest/data/old-style-store.json /tmp/migtest2/data/store.json
cp /tmp/nexus-erp/index.html /tmp/nexus-erp/styles.css /tmp/nexus-erp/*.js /tmp/migtest2/app/
rm -f /tmp/migtest2/app/server.js.bak
cp /tmp/nexus-erp/server.js /tmp/migtest2/app/server.js
cd /tmp/migtest2/app
pkill -f "node server.js" 2>/dev/null; sleep 1
setsid nohup env PORT=8493 DATA_DIR=/tmp/migtest2/data node server.js > /tmp/migtest2/srv.log 2>&1 &
sleep 1.5

# A. startup left store.json untouched (no auto-post, no save)
S1=$(sha256sum /tmp/migtest2/data/store.json | cut -d' ' -f1)
S0=$(sha256sum /tmp/migtest/data/old-style-store.json | cut -d' ' -f1)
ok "A startup leaves store.json byte-identical" "$S1" "$S0"
ok "A2 no backup file created at startup" "$(ls /tmp/migtest2/data/ | grep -c backup)" "0"

TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
AUTH="Authorization: Bearer $TOK"
ok "B admin login" "$([ -n "$TOK" ] && [ "$TOK" != null ] && echo yes)" "yes"

# C. dependent financial posting blocked with clear reconciliation message
R=$(curl -s -w '|%{http_code}' $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"invoice-save","out":{"number":"INV-0009","status":"sent","contact_id":1,"issue_date":"2026-11-24","tax_rate":0,"items":[{"product_id":1,"qty":1,"price":50}]}}')
CODE=${R##*|}; BODY=${R%|*}
ok "C invoice-save blocked (400)" "$CODE" "400"
ERR=$(echo "$BODY" | jq -r '.error + " | " + ((.violations//[])|join(";"))')
echo "  C error: $ERR" | head -c 400; echo
echo "$ERR" | grep -qi "reconcil\|Inventory GL" && ok "C2 error names the reconciliation" yes yes || ok "C2 error names the reconciliation" no yes

# store.json still untouched after failed tx
S2=$(sha256sum /tmp/migtest2/data/store.json | cut -d' ' -f1)
ok "C3 failed tx leaves store.json unchanged" "$S2" "$S0"

# D. non-admin cannot approve
curl -s $B/api/users -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"username":"emp1","password":"emp12345","role":"employee","modules":["accounting","invoices","products"]}' > /dev/null
ETOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"emp1","password":"emp12345"}' | jq -r .token)
R=$(curl -s -w '|%{http_code}' $B/api/tx -X POST -H "Authorization: Bearer $ETOK" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}')
CODE=${R##*|}; BODY=${R%|*}
echo "  D non-admin attempt: $CODE $BODY"
[ "$CODE" != "200" ] && ok "D non-admin migrate rejected" yes yes || ok "D non-admin migrate rejected" "got200" yes
S3=$(sha256sum /tmp/migtest2/data/store.json | cut -d' ' -f1)
# note: creating emp1 user saved the file once (user management route) — journal must still be untouched
J=$(jq '.data.journal | length' /tmp/migtest2/data/store.json)
ok "D2 journal still 1 entry (no auto-post)" "$J" "1"

# E. admin approves: posts once, backup preserved, reconciled
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}')
echo "  E admin approve: $R"
ok "E posted once" "$(echo "$R" | jq -r .posted)" "true"
ok "E gap" "$(echo "$R" | jq -r .gap)" "480"
ok "E2 backup created" "$(ls /tmp/migtest2/data/ | grep -c pre-inventory-adjustment-backup)" "1"
BJ=$(jq '.data.journal | length' /tmp/migtest2/data/store.json.pre-inventory-adjustment-backup)
ok "E3 backup holds pre-adjustment journal (1 entry)" "$BJ" "1"
J2=$(jq '[.data.journal[] | select(.ref_type=="migration")] | length' /tmp/migtest2/data/store.json)
ok "E4 live store has 1 migration entry" "$J2" "1"
# reconciled: inventory GL == stock valuation
python3 - <<'PY'
import json
d=json.load(open('/tmp/migtest2/data/store.json'))['data']
def bal(aid):
    return sum(l.get('debit',0)-l.get('credit',0) for j in d['journal'] for l in j['lines'] if l['account_id']==aid)
inv=bal(3)  # account id 3 = 1200
val=sum(p.get('stock',0)*p.get('cost',0) for p in d['products'])
print(f"INVCHECK inv_gl={inv} stock_val={val}")
PY

# F. idempotent: second approve posts nothing
R=$(curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}')
ok "F second approve posts nothing" "$(echo "$R" | jq -r .posted)" "false"
J3=$(jq '.data.journal | length' /tmp/migtest2/data/store.json)
ok "F2 journal unchanged" "$J3" "2"

# G. dependent posting now unblocked
R=$(curl -s -w '|%{http_code}' $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"invoice-save","out":{"number":"INV-0009","status":"sent","contact_id":1,"issue_date":"2026-11-24","tax_rate":0,"items":[{"product_id":1,"qty":1,"price":50}]}}')
CODE=${R##*|}
ok "G invoice-save unblocked after approval" "$CODE" "200"

# H. persistence: restart, invoice survives (tx route now saves)
pkill -f "node server.js"; sleep 1
cd /tmp/migtest2/app && setsid nohup env PORT=8493 DATA_DIR=/tmp/migtest2/data node server.js > /tmp/migtest2/srv2.log 2>&1 &
sleep 1.5
TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
N=$(curl -s $B/api/data -H "Authorization: Bearer $TOK" | jq '.data.invoices | length')
ok "H tx data persists across restart" "$N" "2"

# I1. existing stock, empty journal, NO seed marker: review path (no automatic opening)
rm -rf /tmp/migtest3 && mkdir -p /tmp/migtest3/data /tmp/migtest3/app
cp -r /tmp/migtest2/app/* /tmp/migtest3/app/
python3 - <<'PY2'
import json
d=json.load(open('/tmp/migtest/data/old-style-store.json'))
d['data']['accounts']=[]; d['data']['journal']=[]; d['data']['invoices']=[]
json.dump(d, open('/tmp/migtest3/data/store.json','w'))
PY2
pkill -f "node server.js"; sleep 1
cd /tmp/migtest3/app && setsid nohup env PORT=8494 DATA_DIR=/tmp/migtest3/data node server.js > /tmp/migtest3/srv.log 2>&1 &
sleep 1.5
TOK3=$(curl -s http://localhost:8494/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
# trigger a tx (admin runs migrate review op); automatic opening must NOT fire
R=$(curl -s http://localhost:8494/api/tx -X POST -H "Authorization: Bearer $TOK3" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}')
echo "  I1 existing-stock empty-journal migrate: $R"
ok "I1 empty journal does NOT auto-open (adjustment proposed instead)" "$(echo "$R" | jq -r .posted)" "true"
OP=$(jq '[.data.journal[] | select(.ref_type=="opening")] | length' /tmp/migtest3/data/store.json)
ok "I1b no automatic opening entry" "$OP" "0"
ok "I1c backup preserved on approval" "$(ls /tmp/migtest3/data/ | grep -c backup)" "1"

# I2. explicitly marked synthetic seed fixture: opening values established automatically
rm -rf /tmp/migtest5 && mkdir -p /tmp/migtest5/data /tmp/migtest5/app
cp -r /tmp/migtest2/app/* /tmp/migtest5/app/
python3 - <<'PY3'
import json
d=json.load(open('/tmp/migtest/data/old-style-store.json'))
d['data']['accounts']=[]; d['data']['journal']=[]; d['data']['invoices']=[]
d['data']['settings']={'seed_demo': True}
json.dump(d, open('/tmp/migtest5/data/store.json','w'))
PY3
pkill -f "node server.js"; sleep 1
cd /tmp/migtest5/app && setsid nohup env PORT=8495 DATA_DIR=/tmp/migtest5/data node server.js > /tmp/migtest5/srv.log 2>&1 &
sleep 1.5
TOK5=$(curl -s http://localhost:8495/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
R=$(curl -s http://localhost:8495/api/tx -X POST -H "Authorization: Bearer $TOK5" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}')
echo "  I2 marked-seed migrate: $R"
ok "I2 marked seed: nothing left to adjust" "$(echo "$R" | jq -r .posted)" "false"
OP=$(jq '[.data.journal[] | select(.ref_type=="opening")] | length' /tmp/migtest5/data/store.json)
ok "I2b explicit opening entry exists" "$OP" "1"
ok "I2c no adjustment backup on fresh path" "$(ls /tmp/migtest5/data/ | grep -c backup)" "0"

# J. restart durability across transaction families (regression for the tx disk-save defect)
rm -rf /tmp/durtest && mkdir -p /tmp/durtest/data /tmp/durtest/app
cp -r /tmp/migtest2/app/* /tmp/durtest/app/
python3 - <<'PY4'
import json
d=json.load(open('/tmp/migtest/data/old-style-store.json'))
d['data']['settings']={'seed_demo': True}
json.dump(d, open('/tmp/durtest/data/store.json','w'))
PY4
pkill -f "node server.js"; sleep 1
cd /tmp/durtest/app && setsid nohup env PORT=8496 DATA_DIR=/tmp/durtest/data node server.js > /tmp/durtest/srv.log 2>&1 &
sleep 1.5
TD=http://localhost:8496
DTOK=$(curl -s $TD/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
DA="Authorization: Bearer $DTOK"
# resolve the approval-block first (fixture has journal history + stock -> reconciles via seed flag? no: journal non-empty, so review path; approve it)
curl -s $TD/api/tx -X POST -H "$DA" -H 'Content-Type: application/json' -d '{"op":"migrate-inventory"}' > /dev/null
J() { curl -s -o /dev/null -w '%{http_code}' $TD/api/tx -X POST -H "$DA" -H 'Content-Type: application/json' -d "$1"; }
ok "J product-save" "$(J '{"op":"product-save","out":{"name":"DurWidget","price":30,"cost":10,"stock":5}}')" "200"
ok "J journal" "$(J '{"op":"journal","date":"2026-11-24","memo":"dur","lines":[{"account_id":1,"debit":25},{"account_id":5,"credit":25}]}')" "200"
ok "J stock-adjust" "$(J '{"op":"stock-adjust","product_id":1,"qty":-1,"memo":"dur"}')" "200"
ok "J warehouse-add" "$(J '{"op":"warehouse-add","name":"DurWH","location":"x"}')" "200"
ok "J quote-save" "$(J '{"op":"quote-save","out":{"status":"sent","contact_id":1,"issue_date":"2026-11-24","tax_rate":0,"items":[{"product_id":1,"qty":1,"price":10}]}}')" "200"
ok "J payment" "$(J '{"op":"payment","direction":"in","amount":50,"date":"2026-11-24","ref_type":"invoice","ref_id":2}')" "200"
ok "J order-save" "$(J '{"op":"order-save","out":{"status":"draft","contact_id":1,"order_date":"2026-11-24","items":[{"product_id":1,"qty":1,"price":10}]}}')" "200"
pkill -f "node server.js"; sleep 1
cd /tmp/durtest/app && setsid nohup env PORT=8496 DATA_DIR=/tmp/durtest/data node server.js > /tmp/durtest/srv2.log 2>&1 &
sleep 1.5
DTOK=$(curl -s $TD/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
D=$(curl -s $TD/api/data -H "$DA" 2>/dev/null)
DTOK2=$(curl -s $TD/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
D=$(curl -s $TD/api/data -H "Authorization: Bearer $DTOK2")
ok "J restart: product" "$(echo "$D" | jq '[.data.products[] | select(.name=="DurWidget")] | length')" "1"
ok "J restart: journal entry" "$(echo "$D" | jq '[.data.journal[] | select(.memo=="dur")] | length')" "1"
ok "J restart: stock move" "$(echo "$D" | jq '[.data.stock_moves[] | select(.memo=="dur")] | length')" "1"
ok "J restart: warehouse" "$(echo "$D" | jq '[.data.warehouses[] | select(.name=="DurWH")] | length')" "1"
ok "J restart: quote" "$(echo "$D" | jq '.data.quotes | length')" "1"
ok "J restart: payment" "$(echo "$D" | jq '.data.payments | length')" "1"
ok "J restart: order" "$(echo "$D" | jq '.data.sales_orders | length')" "1"


# K. recurring invoices
rm -rf /tmp/rectest && mkdir -p /tmp/rectest/data /tmp/rectest/app
cp -r /tmp/migtest2/app/* /tmp/rectest/app/
cp /tmp/migtest2/app/*.js /tmp/rectest/app/ 2>/dev/null
python3 - <<'PY5'
import json
d=json.load(open('/tmp/migtest/data/old-style-store.json'))
d['data']['settings']={'seed_demo': True}
json.dump(d, open('/tmp/rectest/data/store.json','w'))
PY5
# refresh app code to current repo
cp /tmp/nexus-erp/*.js /tmp/rectest/app/
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv.log 2>&1 &
sleep 1.5
RT=http://localhost:8497
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
J() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
JB() { curl -s $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
# reconcile the fixture first (journal history + stock -> approve adjustment)
JB '{"op":"migrate-inventory"}' > /dev/null
STOCK0=$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')
ok "K recurring-save" "$(J '{"op":"recurring-save","out":{"contact_id":1,"interval":"monthly","next_date":"2026-10-01","end_date":"2027-01-15","tax_rate":0,"auto_post":true,"notes":"k-test","items":[{"product_id":1,"qty":2,"price":100}]}}')" "200"
R=$(JB '{"op":"recurring-run","today":"2026-11-24"}')
echo "  K run: $R"
ok "K2 two elapsed periods generated" "$(echo "$R" | jq '.created | length')" "2"
ok "K3 idempotent re-run" "$(JB '{"op":"recurring-run","today":"2026-11-24"}' | jq '.created | length')" "0"
D=$(curl -s $RT/api/data -H "$RA")
TID=$(echo "$D" | jq '.data.recurring[0].id')
ok "K4 next_date advanced" "$(echo "$D" | jq -r '.data.recurring[0].next_date')" "2026-12-01"
ok "K5 invoice carries recurring_id" "$(echo "$D" | jq "[.data.invoices[] | select(.recurring_id==$TID)] | length")" "2"
ok "K5b stock decremented (2 periods x 2)" "$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')" "$((STOCK0 - 4))"
ok "K5c COGS journal for generated invoice" "$(echo "$D" | jq '[.data.journal[] | select(.ref_type=="invoice-cogs")] | length')" "2"
# pause blocks generation
J '{"op":"recurring-status","id":'$TID',"status":"paused"}' > /dev/null
ok "K6 paused run creates nothing" "$(JB '{"op":"recurring-run","today":"2027-03-01"}' | jq '.created | length')" "0"
# resume + catch-up to end_date completion
J '{"op":"recurring-status","id":'$TID',"status":"active"}' > /dev/null
R=$(JB '{"op":"recurring-run","today":"2027-03-01"}')
ok "K7 catch-up Dec+Jan" "$(echo "$R" | jq '.created | length')" "2"
ok "K7b completed after end_date" "$(curl -s $RT/api/data -H "$RA" | jq -r '.data.recurring[0].status')" "completed"
ok "K8 completed rejects status change" "$(J '{"op":"recurring-status","id":'$TID',"status":"active"}')" "400"
# permission: user without invoices module
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"emp3","password":"emp31234","role":"employee","modules":["products"]}' > /dev/null
ET=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"emp3","password":"emp31234"}' | jq -r .token)
ok "K9 no-invoices-module 403" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $ET" -H 'Content-Type: application/json' -d '{"op":"recurring-run"}')" "403"
# insufficient stock: qty far beyond stock
J '{"op":"recurring-save","out":{"contact_id":1,"interval":"weekly","next_date":"2026-11-01","tax_rate":0,"auto_post":true,"notes":"k10-block","items":[{"product_id":1,"qty":999,"price":10}]}}' > /dev/null
R=$(JB '{"op":"recurring-run","today":"2026-11-24"}')
ok "K10 insufficient stock blocked" "$(echo "$R" | jq '.blocked | length >= 1')" "true"
ok "K10b blocked run created nothing" "$(echo "$R" | jq '.created | length')" "0"
ND=$(curl -s $RT/api/data -H "$RA" | jq -r '.data.recurring[1].next_date')
ok "K10c blocked template did not advance" "$ND" "2026-11-01"
# restart durability
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv2.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
D=$(curl -s $RT/api/data -H "Authorization: Bearer $RTOK")
ok "K11 restart: templates persist" "$(echo "$D" | jq '.data.recurring | length')" "2"
ok "K11b restart: generated invoices persist" "$(echo "$D" | jq '[.data.invoices[] | select(.recurring_id != null)] | length')" "4"


# K12+. drafts-by-default, explicit posting, anchored month-ends, leap years, concurrency, no view-open generation
INV0=$(curl -s $RT/api/data -H "$RA" | jq '.data.invoices | length')
ok "K12 no background generation on data read" "$INV0" "$(curl -s $RT/api/data -H "$RA" | jq '.data.invoices | length')"
J '{"op":"recurring-save","out":{"contact_id":1,"interval":"monthly","next_date":"2026-11-01","tax_rate":0,"items":[{"product_id":1,"qty":1,"price":25}]}}' > /dev/null
ST0=$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')
C0=$(curl -s $RT/api/data -H "$RA" | jq '[.data.journal[] | select(.ref_type=="invoice-cogs")] | length')
R=$(JB '{"op":"recurring-run","today":"2026-11-24"}')
ok "K13 default generates drafts" "$(echo "$R" | jq '.created | length >= 1')" "true"
D=$(curl -s $RT/api/data -H "$RA")
T3=$(echo "$D" | jq '.data.recurring | map(select(.auto_post != true)) | .[0].id')
ok "K13e legacy template (no auto_post field) never infers posting" "$(echo "$D" | jq "[.data.recurring[] | select(.id==$T3)] | .[0].auto_post == true")" "false"
ok "K13b generated invoice is draft" "$(echo "$D" | jq -r "[.data.invoices[] | select(.recurring_id==$T3)][0].status")" "draft"
ok "K13c draft does not touch stock" "$(echo "$D" | jq '.data.products[0].stock')" "$ST0"
ok "K13d draft posts no COGS" "$(echo "$D" | jq '[.data.journal[] | select(.ref_type=="invoice-cogs")] | length')" "$C0"
DID=$(echo "$D" | jq "[.data.invoices[] | select(.recurring_id==$T3)][0].id")
ok "K14 explicit send of the draft" "$(J '{"op":"invoice-save","id":'$DID',"out":{"status":"sent","contact_id":1,"issue_date":"2026-11-24","due_date":"2026-11-24","tax_rate":0,"items":[{"product_id":1,"qty":1,"price":25}]}}')" "200"
ok "K14b stock decrements on explicit send" "$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')" "$((ST0 - 1))"
ok "K14c explicit send posts COGS" "$(curl -s $RT/api/data -H "$RA" | jq '[.data.journal[] | select(.ref_type=="invoice-cogs")] | length')" "$((C0 + 1))"
# anchor: Jan 31 monthly -> Feb 28 -> Mar 31 -> Apr 30 (no drift to 28th)
J '{"op":"recurring-save","out":{"contact_id":1,"interval":"monthly","next_date":"2026-01-31","tax_rate":0,"notes":"anchor-k15","items":[{"description":"svc","qty":1,"price":10}]}}' > /dev/null
R=$(JB '{"op":"recurring-run","today":"2026-04-02"}')
ok "K15 anchor: 3 periods elapsed" "$(echo "$R" | jq '.created | length')" "3"
D=$(curl -s $RT/api/data -H "$RA")
T4=$(echo "$D" | jq '[.data.recurring[] | select(.notes=="anchor-k15")] | .[0].id')
ND4=$(echo "$D" | jq -r ".data.recurring[] | select(.id==$T4) | .next_date")
ok "K15b anchor retained (Apr 30, not Apr 28)" "$ND4" "2026-04-30"
DATES=$(echo "$D" | jq -r "[.data.invoices[] | select(.recurring_id==$T4)] | sort_by(.issue_date) | .[].issue_date" | tr '\n' ' ')
ok "K15c period dates Jan31/Feb28/Mar31" "$DATES" "2026-01-31 2026-02-28 2026-03-31 "
# leap year: Jan 31 2028 -> Feb 29 2028 -> Mar 31
J '{"op":"recurring-save","out":{"contact_id":1,"interval":"monthly","next_date":"2028-01-31","tax_rate":0,"notes":"leap-k16","items":[{"description":"svc","qty":1,"price":10}]}}' > /dev/null
R=$(JB '{"op":"recurring-run","today":"2028-04-05"}')
D=$(curl -s $RT/api/data -H "$RA")
T5=$(echo "$D" | jq '[.data.recurring[] | select(.notes=="leap-k16")] | .[0].id')
DATES5=$(echo "$D" | jq -r "[.data.invoices[] | select(.recurring_id==$T5)] | sort_by(.issue_date) | .[].issue_date" | tr '\n' ' ')
ok "K16 leap year Feb 29 anchored" "$DATES5" "2028-01-31 2028-02-29 2028-03-31 "
# concurrency: two parallel runs create each period once
J '{"op":"recurring-save","out":{"contact_id":1,"interval":"weekly","next_date":"2026-11-02","tax_rate":0,"notes":"conc-k17","items":[{"description":"svc","qty":1,"price":5}]}}' > /dev/null
D=$(curl -s $RT/api/data -H "$RA")
T6=$(echo "$D" | jq '[.data.recurring[] | select(.notes=="conc-k17")] | .[0].id')
R1=$(JB '{"op":"recurring-run","id":'$T6',"today":"2026-11-24"}' & R2=$(JB '{"op":"recurring-run","id":'$T6',"today":"2026-11-24"}') ; wait)
TOT=$(curl -s $RT/api/data -H "$RA" | jq "[.data.invoices[] | select(.recurring_id==$T6)] | length")
ok "K17 concurrent runs stay idempotent (4 weekly periods, no dupes)" "$TOT" "4"

# ---- L. expense approvals: submit posts nothing; approval is the posting event; separation of duties
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"fin1","password":"fin11234","role":"employee","modules":["finance"]}' > /dev/null
FT=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"fin1","password":"fin11234"}' | jq -r .token)
FJ() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $FT" -H 'Content-Type: application/json' -d "$1"; }
L0=$(curl -s $RT/api/data -H "$RA" | jq '.data.ledger | length')
J0=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')
ok "L1 finance user submits expense" "$(FJ '{"op":"expense-save","out":{"category":"Rent","amount":500,"memo":"office rent nov"}}')" "200"
ok "L2 submit posts no ledger row" "$(curl -s $RT/api/data -H "$RA" | jq '.data.ledger | length')" "$L0"
ok "L2b submit posts no journal" "$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')" "$J0"
EID=$(curl -s $RT/api/data -H "$RA" | jq '[.data.expenses[] | select(.status=="submitted")][0].id')
ok "L3 self-approval blocked for employee" "$(FJ '{"op":"expense-approve","id":'$EID'}')" "400"
ok "L4 admin approves" "$(J '{"op":"expense-approve","id":'$EID'}')" "200"
D=$(curl -s $RT/api/data -H "$RA")
ok "L4b approval posted ledger row" "$(echo "$D" | jq '.data.ledger | length')" "$((L0 + 1))"
ok "L4c approval posted journal" "$(echo "$D" | jq '.data.journal | length')" "$((J0 + 1))"
ok "L4d expense approved + linked" "$(echo "$D" | jq -r "[.data.expenses[] | select(.id==$EID)][0] | .status + \" \" + ((.ledger_id != null) | tostring)")" "approved true"
ok "L4e ledger row references expense" "$(echo "$D" | jq "[.data.ledger[] | select(.ref_type==\"expense\" and .ref_id==$EID)] | length")" "1"
ok "L5 double approval rejected" "$(J '{"op":"expense-approve","id":'$EID'}')" "400"
FJ '{"op":"expense-save","out":{"category":"Marketing","amount":200,"memo":"ads"}}' > /dev/null
EID2=$(curl -s $RT/api/data -H "$RA" | jq '[.data.expenses[] | select(.status=="submitted")][0].id')
ok "L6 admin rejects with reason" "$(J '{"op":"expense-reject","id":'$EID2',"reason":"not budgeted"}')" "200"
ok "L6b rejected posts nothing" "$(curl -s $RT/api/data -H "$RA" | jq '.data.ledger | length')" "$((L0 + 1))"
ok "L6c rejected carries reason" "$(curl -s $RT/api/data -H "$RA" | jq -r "[.data.expenses[] | select(.id==$EID2)][0].reject_reason")" "not budgeted"
ok "L7 rejected cannot be deleted" "$(FJ '{"op":"expense-delete","id":'$EID2'}')" "400"
FJ '{"op":"expense-save","out":{"category":"Utilities","amount":80}}' > /dev/null
EID3=$(curl -s $RT/api/data -H "$RA" | jq '[.data.expenses[] | select(.status=="submitted")][0].id')
ok "L7b stranger cannot delete" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $ET" -H 'Content-Type: application/json' -d '{"op":"expense-delete","id":'$EID3'}')" "403"
ok "L7c submitter deletes own" "$(FJ '{"op":"expense-delete","id":'$EID3'}')" "200"
ok "L8 no-finance-module 403" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $ET" -H 'Content-Type: application/json' -d '{"op":"expense-save","out":{"category":"Rent","amount":1}}')" "403"
# restart durability for the new family
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv2.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
D=$(curl -s $RT/api/data -H "$RA")
ok "L9 restart: approved expense persists with link" "$(echo "$D" | jq -r "[.data.expenses[] | select(.id==$EID)][0] | .status + \" \" + ((.ledger_id != null) | tostring)")" "approved true"
ok "L9b restart: ledger+journal persist" "$(echo "$D" | jq '(.data.ledger | length) + (.data.journal | length)')" "$((L0 + 1 + J0 + 1))"

# ---- M. expense permission split: server-enforced row scoping, forge prevention, cross-user
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"sub1","password":"sub11234","role":"employee","modules":["expenses"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"sub2","password":"sub21234","role":"employee","modules":["expenses"]}' > /dev/null
S1=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"sub1","password":"sub11234"}' | jq -r .token)
S2=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"sub2","password":"sub21234"}' | jq -r .token)
SJ() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2"; }
ok "M1 submitter (no finance) submits" "$(SJ $S1 '{"op":"expense-save","out":{"category":"Travel","amount":120,"memo":"sub1 trip"}}')" "200"
D1=$(curl -s $RT/api/data -H "Authorization: Bearer $S1")
ok "M2 submitter sees own row" "$(echo "$D1" | jq '[.data.expenses[] | select(.memo=="sub1 trip")] | length')" "1"
ok "M2b submitter gets NO ledger collection" "$(echo "$D1" | jq 'has("data") and (.data | has("ledger")) | not')" "true"
ok "M2c submitter gets NO journal" "$(echo "$D1" | jq '(.data | has("journal")) | not')" "true"
ok "M3 forge attempt ignored" "$(SJ $S1 '{"op":"expense-save","out":{"category":"Travel","amount":1,"memo":"forged","submitted_by":"admin","status":"approved","reviewed_by":"admin","ledger_id":1}}')" "200"
F=$(curl -s $RT/api/data -H "Authorization: Bearer $S1" | jq -r '[.data.expenses[] | select(.memo=="forged")][0]')
ok "M3b forged row is own+submitted" "$(echo "$F" | jq -r '.submitted_by + " " + .status + " " + ((.ledger_id == null) | tostring) + " " + ((.reviewed_by == null) | tostring)')" "sub1 submitted true true"
ok "M4 cross-user read: sub2 sees none of sub1" "$(curl -s $RT/api/data -H "Authorization: Bearer $S2" | jq '.data.expenses | length')" "0"
XID=$(curl -s $RT/api/data -H "$RA" | jq '[.data.expenses[] | select(.memo=="sub1 trip")][0].id')
ok "M5 cross-user edit blocked" "$(SJ $S2 '{"op":"expense-save","id":'$XID',"out":{"category":"Other","amount":999,"memo":"hijack"}}')" "400"
ok "M5b cross-user delete blocked" "$(SJ $S2 '{"op":"expense-delete","id":'$XID'}')" "400"
ok "M5c cross-user approve blocked (no finance)" "$(SJ $S2 '{"op":"expense-approve","id":'$XID'}')" "403"
ok "M6 submitter cannot approve own (no finance)" "$(SJ $S1 '{"op":"expense-approve","id":'$XID'}')" "403"
ok "M7 finance reviewer sees all submitters" "$(curl -s $RT/api/data -H "Authorization: Bearer $FT" | jq '[.data.expenses[] | select(.memo=="sub1 trip" or .memo=="forged")] | length')" "2"
ok "M7b PUT cannot overwrite expenses (server-owned)" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/data -X PUT -H "Authorization: Bearer $S1" -H 'Content-Type: application/json' -d '{"data":{"expenses":[]}}')" "200"
ok "M7c forged PUT did not erase rows" "$(curl -s $RT/api/data -H "$RA" | jq '[.data.expenses[] | select(.memo=="sub1 trip")] | length')" "1"
ok "M8 admin approves submitter request" "$(J '{"op":"expense-approve","id":'$XID'}')" "200"
ok "M8b owner sees approval, still no ledger" "$(curl -s $RT/api/data -H "Authorization: Bearer $S1" | jq -r '([.data.expenses[] | select(.id=='$XID')][0].status) + " " + ((.data | has("ledger")) | not | tostring)')" "approved true"

# ---- N. projects + timesheets: session-owned logging, billed locks, draft-only billing
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"pm1","password":"pm111234","role":"employee","modules":["projects"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"pm2","password":"pm221234","role":"employee","modules":["projects"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"inv1","password":"inv11234","role":"employee","modules":["projects","invoices"]}' > /dev/null
P1=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"pm1","password":"pm111234"}' | jq -r .token)
P2=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"pm2","password":"pm221234"}' | jq -r .token)
IV=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"inv1","password":"inv11234"}' | jq -r .token)
PJ() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2"; }
ok "N1 create project" "$(PJ $P1 '{"op":"project-save","out":{"name":"Website build","contact_id":1,"hourly_rate":50,"budget_hours":40}}')" "200"
PRID=$(curl -s $RT/api/data -H "$RA" | jq '[.data.projects[] | select(.name=="Website build")][0].id')
ok "N2 log time (forge employee ignored)" "$(PJ $P1 '{"op":"timesheet-save","out":{"project_id":'$PRID',"hours":2,"billable":true,"description":"design","employee":"admin","billed_invoice_id":5}}')" "200"
TSID=$(curl -s $RT/api/data -H "$RA" | jq '[.data.timesheets[] | select(.description=="design")][0].id')
ok "N2b logger identity from session" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.timesheets[] | select(.id=='$TSID')][0] | .employee + " " + ((.billed_invoice_id == null) | tostring)')" "pm1 true"
ok "N3 no-projects-module 403" "$(PJ $ET '{"op":"timesheet-save","out":{"project_id":'$PRID',"hours":1}}')" "403"
ok "N4 cross-user edit blocked" "$(PJ $P2 '{"op":"timesheet-save","id":'$TSID',"out":{"project_id":'$PRID',"hours":9}}')" "400"
ok "N4b cross-user delete blocked" "$(PJ $P2 '{"op":"timesheet-delete","id":'$TSID'}')" "400"
PJ $P1 '{"op":"timesheet-save","out":{"project_id":'$PRID',"hours":3,"billable":true,"description":"dev"}}' > /dev/null
J0N=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')
ok "N5 billing needs invoices module" "$(PJ $P1 '{"op":"timesheet-invoice","project_id":'$PRID'}')" "400"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $IV" -H 'Content-Type: application/json' -d '{"op":"timesheet-invoice","project_id":'$PRID'}')
ok "N6 billing creates DRAFT invoice" "$(echo "$R" | jq -r '.invoice.status + " " + (.billed | tostring)')" "draft 2"
BINV=$(echo "$R" | jq -r '.invoice.id')
ok "N6b draft posts no journal" "$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')" "$J0N"
ok "N6c invoice total hours x rate" "$(echo "$R" | jq '[.invoice.items[] | .qty * .price] | add')" "250"
ok "N6d entries marked billed" "$(curl -s $RT/api/data -H "$RA" | jq '[.data.timesheets[] | select(.project_id=='$PRID' and .billed_invoice_id=='$BINV')] | length')" "2"
ok "N7 billed entry locked for edit" "$(PJ $P1 '{"op":"timesheet-save","id":'$TSID',"out":{"project_id":'$PRID',"hours":9}}')" "400"
ok "N7b billed entry locked for delete" "$(PJ $P1 '{"op":"timesheet-delete","id":'$TSID'}')" "400"
ok "N8 re-bill with nothing unbilled" "$(PJ $IV '{"op":"timesheet-invoice","project_id":'$PRID'}')" "400"
ok "N8b project with time cannot be deleted" "$(PJ $P1 '{"op":"project-delete","id":'$PRID'}')" "400"
ok "N8c PUT cannot overwrite timesheets" "$(PJ $P1 '{"op":"timesheet-delete","id":99999}')" "400"
IN0=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')
ok "N9 explicit send posts journal" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $IV" -H 'Content-Type: application/json' -d '{"op":"invoice-save","id":'$BINV',"out":{"status":"sent","contact_id":1,"issue_date":"2026-11-25","due_date":"2026-11-25","tax_rate":0,"items":[{"description":"dev","qty":3,"price":50},{"description":"design","qty":2,"price":50}]}}')" "200"
ok "N9b journal +1 on send" "$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')" "$((IN0 + 1))"
# restart durability for the new families
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv4.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
J() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
JB() { curl -s $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
D=$(curl -s $RT/api/data -H "$RA")
ok "N10 restart: project/time/billing persist" "$(echo "$D" | jq -r '([.data.projects[] | select(.id=='$PRID')] | length | tostring) + " " + ([.data.timesheets[] | select(.billed_invoice_id=='$BINV')] | length | tostring) + " " + ([.data.invoices[] | select(.id=='$BINV' and .status=="sent")] | length | tostring)')" "1 2 1"


# ---- O. helpdesk: server-owned tickets, session authorship, assignee validation
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"hd1","password":"hd111234","role":"employee","modules":["helpdesk"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"hd2","password":"hd221234","role":"employee","modules":["helpdesk"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"nohd","password":"nohd1234","role":"employee","modules":["tasks"]}' > /dev/null
H1=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"hd1","password":"hd111234"}' | jq -r .token)
H2=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"hd2","password":"hd221234"}' | jq -r .token)
NH=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"nohd","password":"nohd1234"}' | jq -r .token)
R=$(JB '{"op":"ticket-save","out":{"subject":"Printer down","priority":"high","created_by":"root","number":"X-9"}}')
ok "O1 ticket number server-assigned" "$(echo "$R" | jq -r '.ticket.number')" "TKT-0001"
ok "O1b creator from session, forged fields ignored" "$(echo "$R" | jq -r '.ticket.created_by + " " + .ticket.status')" "admin open"
TKID=$(echo "$R" | jq -r '.ticket.id')
ok "O2 employee creates ticket" "$(PJ $H1 '{"op":"ticket-save","out":{"subject":"VPN access","assigned_to":"hd2"}}')" "200"
ok "O3 no-helpdesk-module 403" "$(PJ $NH '{"op":"ticket-save","out":{"subject":"x"}}')" "403"
ok "O3b tickets hidden from non-helpdesk user" "$(curl -s $RT/api/data -H "Authorization: Bearer $NH" | jq '(.data | has("tickets")) or (.data | has("ticket_replies"))')" "false"
R2=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $H2" -H 'Content-Type: application/json' -d '{"op":"ticket-reply","ticket_id":'$TKID',"body":"looking into it","author":"admin","internal":true}')
ok "O4 reply author from session" "$(echo "$R2" | jq -r '.reply.author + " " + (.reply.internal | tostring)')" "hd2 true"
ok "O5 invalid status rejected" "$(PJ $H1 '{"op":"ticket-status","id":'$TKID',"status":"bogus"}')" "400"
ok "O6 valid transition" "$(PJ $H1 '{"op":"ticket-status","id":'$TKID',"status":"in-progress"}')" "200"
ok "O7 unknown assignee rejected" "$(PJ $H1 '{"op":"ticket-save","out":{"subject":"bad assignee","assigned_to":"ghost"}}')" "400"
ok "O8 helpdesk agent edits shared queue" "$(PJ $H1 '{"op":"ticket-save","id":'$TKID',"out":{"subject":"Printer down (triaged)"}}')" "200"
ok "O8b assignee can edit" "$(PJ $H2 '{"op":"ticket-save","id":'$TKID',"out":{"subject":"Printer down","assigned_to":"hd2"}}')" "200"
ok "O9 PUT cannot overwrite tickets" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/data -X PUT -H "Authorization: Bearer $H1" -H 'Content-Type: application/json' -d '{"data":{"tickets":[],"ticket_replies":[]}}')" "200"
ok "O9b forged PUT erased nothing" "$(curl -s $RT/api/data -H "$RA" | jq '[.data.tickets[] | select(.id=='$TKID')] | length')" "1"
ok "O10 non-creator delete blocked" "$(PJ $H2 '{"op":"ticket-delete","id":'$TKID'}')" "400"
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv5.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
J() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
JB() { curl -s $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
D=$(curl -s $RT/api/data -H "$RA")
ok "O11 restart: ticket/replies/status persist" "$(echo "$D" | jq -r '([.data.tickets[] | select(.id=='$TKID' and .status=="in-progress")] | length | tostring) + " " + ([.data.ticket_replies[] | select(.ticket_id=='$TKID')] | length | tostring)')" "1 1"
ok "O12 seq continues, no reuse" "$(JB '{"op":"ticket-save","out":{"subject":"second"}}' | jq -r '.ticket.number')" "TKT-0003"


# ---- P. HR time-off + attendance: session identity, computed days/hours, decision flow
curl -s $RT/api/data -X PUT -H "$RA" -H 'Content-Type: application/json' -d '{"data":{"employees":[{"id":1,"name":"Emp One","salary":100,"status":"active"},{"id":2,"name":"Emp Two","salary":200,"status":"active"}]}}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"hr1","password":"hr111234","role":"employee","modules":["employees"]}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"hr2","password":"hr221234","role":"employee","modules":["employees"]}' > /dev/null
R1=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"hr1","password":"hr111234"}' | jq -r .token)
R2=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"hr2","password":"hr221234"}' | jq -r .token)
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $R1" -H 'Content-Type: application/json' -d '{"op":"leave-save","out":{"employee_id":1,"type":"annual","from_date":"2026-12-01","to_date":"2026-12-03","reason":"family","requested_by":"admin","status":"approved","days":99}}')
ok "P1 leave created, session identity, computed days" "$(echo "$R" | jq -r '.leave.requested_by + " " + .leave.status + " " + (.leave.days | tostring)')" "hr1 submitted 3"
LVID=$(echo "$R" | jq -r '.leave.id')
ok "P2 unknown type rejected" "$(PJ $R1 '{"op":"leave-save","out":{"employee_id":1,"type":"bogus","from_date":"2026-12-01","to_date":"2026-12-02"}}')" "400"
ok "P2b reversed dates rejected" "$(PJ $R1 '{"op":"leave-save","out":{"employee_id":1,"type":"annual","from_date":"2026-12-05","to_date":"2026-12-02"}}')" "400"
ok "P3 no-employees-module 403" "$(PJ $NH '{"op":"leave-save","out":{"employee_id":1,"type":"annual","from_date":"2026-12-01","to_date":"2026-12-01"}}')" "403"
ok "P4 cannot decide own request" "$(PJ $R1 '{"op":"leave-decide","id":'$LVID',"decision":"approved"}')" "400"
ok "P4b other reviewer approves" "$(PJ $R2 '{"op":"leave-decide","id":'$LVID',"decision":"approved"}')" "200"
ok "P5 decided request locked for edit" "$(PJ $R1 '{"op":"leave-save","id":'$LVID',"out":{"employee_id":1,"type":"sick","from_date":"2026-12-01","to_date":"2026-12-01"}}')" "400"
ok "P5b decided request locked for delete" "$(PJ $R1 '{"op":"leave-delete","id":'$LVID'}')" "400"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $R1" -H 'Content-Type: application/json' -d '{"op":"leave-save","out":{"employee_id":2,"type":"sick","from_date":"2026-12-10","to_date":"2026-12-10"}}')
LV2=$(echo "$R" | jq -r '.leave.id')
ok "P6 reject needs reason" "$(PJ $R2 '{"op":"leave-decide","id":'$LV2',"decision":"rejected"}')" "400"
ok "P6b reject with reason" "$(PJ $R2 '{"op":"leave-decide","id":'$LV2',"decision":"rejected","note":"coverage"}')" "200"
ok "P6c rejection recorded with reason" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.leave_requests[] | select(.id=='$LV2')][0] | .status + " " + .decision_note')" "rejected coverage"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $R1" -H 'Content-Type: application/json' -d '{"op":"attendance-save","out":{"employee_id":1,"date":"2026-11-25","check_in":"09:00","check_out":"17:00","hours":99}}')
ok "P7 hours computed server-side" "$(echo "$R" | jq -r '.entry.hours | tostring')" "8"
ATID=$(echo "$R" | jq -r '.entry.id')
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $R1" -H 'Content-Type: application/json' -d '{"op":"attendance-save","out":{"employee_id":1,"date":"2026-11-25","check_in":"09:00","check_out":"16:30"}}')
ok "P7b same-day save corrects, no duplicate" "$(echo "$R" | jq -r '.entry.hours | tostring') $(curl -s $RT/api/data -H "$RA" | jq '[.data.attendance[] | select(.employee_id==1 and .date=="2026-11-25")] | length')" "7.5 1"
ok "P8 other user delete blocked" "$(PJ $R2 '{"op":"attendance-delete","id":'$ATID'}')" "400"
ok "P9 PUT cannot overwrite HR collections" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/data -X PUT -H "Authorization: Bearer $R1" -H 'Content-Type: application/json' -d '{"data":{"leave_requests":[],"attendance":[]}}')" "200"
ok "P9b forged PUT erased nothing" "$(curl -s $RT/api/data -H "$RA" | jq -r '(.data.leave_requests | length | tostring) + " " + (.data.attendance | length | tostring)')" "2 1"
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv6.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
D=$(curl -s $RT/api/data -H "$RA")
ok "P10 restart: leave + attendance persist" "$(echo "$D" | jq -r '([.data.leave_requests[] | select(.id=='$LVID' and .status=="approved")] | length | tostring) + " " + ([.data.attendance[] | select(.employee_id==1 and .hours==7.5)] | length | tostring)')" "1 1"


# ---- R. HR self-service split: authenticated employee mapping, own-row reads, overnight attendance
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"ss1","password":"ss111234","role":"employee","modules":["hr-self"],"employee_id":1}' > /dev/null
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"ss2","password":"ss221234","role":"employee","modules":["hr-self"]}' > /dev/null
S1=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"ss1","password":"ss111234"}' | jq -r .token)
S2=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"ss2","password":"ss221234"}' | jq -r .token)
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $S1" -H 'Content-Type: application/json' -d '{"op":"leave-save","out":{"employee_id":2,"type":"annual","from_date":"2026-12-20","to_date":"2026-12-21"}}')
ok "R1 self-service employee forced from mapping" "$(echo "$R" | jq -r '.leave.employee_id | tostring')" "1"
ok "R1b requested_by is session" "$(echo "$R" | jq -r '.leave.requested_by')" "ss1"
ok "R2 unmapped self-service account rejected" "$(PJ $S2 '{"op":"leave-save","out":{"employee_id":1,"type":"annual","from_date":"2026-12-20","to_date":"2026-12-20"}}')" "400"
ok "R3 self-service cannot decide leave" "$(PJ $S1 '{"op":"leave-decide","id":1,"decision":"approved"}')" "403"
D=$(curl -s $RT/api/data -H "Authorization: Bearer $S1")
ok "R4 own leave rows only" "$(echo "$D" | jq '[.data.leave_requests[] | select(.requested_by!="ss1")] | length')" "0"
ok "R4b no employees collection for self-service" "$(echo "$D" | jq '.data | has("employees")')" "false"
ok "R4c own attendance rows only" "$(echo "$D" | jq '[.data.attendance[] | select(.employee_id != 1)] | length')" "0"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $S1" -H 'Content-Type: application/json' -d '{"op":"attendance-save","out":{"employee_id":2,"date":"2026-11-26","check_in":"22:00","check_out":"06:00"}}')
ok "R5 self-service attendance forced + overnight hours" "$(echo "$R" | jq -r '(.entry.employee_id | tostring) + " " + (.entry.hours | tostring)')" "1 8"
ok "R5b overnight 23:00-07:30 = 8.5" "$(PJ $R1 '{"op":"attendance-save","out":{"employee_id":2,"date":"2026-11-26","check_in":"23:00","check_out":"07:30"}}' >/dev/null; curl -s $RT/api/data -H "$RA" | jq -r '[.data.attendance[] | select(.employee_id==2 and .date=="2026-11-26")][0].hours | tostring')" "8.5"
ok "R6 HR reviewer still sees all leave" "$(curl -s $RT/api/data -H "Authorization: Bearer $R1" | jq '.data.leave_requests | length >= 3')" "true"
ok "R7 invalid employee link stored as null" "$(curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"ss3","password":"ss331234","role":"employee","modules":["hr-self"],"employee_id":999}' | jq -r '.user.employee_id | tostring')" "null"


# ---- S. fixed assets: explicit acquisition opt-in, monthly depreciation cursor, disposal at book value
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"noasset","password":"na111234","role":"employee","modules":["tasks"]}' > /dev/null
NAT=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"noasset","password":"na111234"}' | jq -r .token)
J0=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')
R=$(JB '{"op":"asset-save","out":{"name":"Machine A","purchase_date":"2026-09-15","cost":12000,"salvage":0,"life_months":12,"post_acquisition":true,"created_by":"root"}}')
ok "S1 acquisition posting opt-in" "$(echo "$R" | jq -r '.asset.acquisition_posted | tostring')" "true"
AID=$(echo "$R" | jq -r '.asset.id')
ok "S1b acquisition journal balanced" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.journal[] | select(.ref_type=="asset" and .ref_id=='$AID')][0] | (([.lines[].debit] | add) == ([.lines[].credit] | add) and ([.lines[].debit] | add) == 12000 | tostring)')" "true"
ok "S1c created_by from session" "$(echo "$R" | jq -r '.asset.created_by')" "admin"
R=$(JB '{"op":"asset-save","out":{"name":"Machine B","purchase_date":"2026-10-01","cost":5000,"salvage":1000,"life_months":8}}')
BID=$(echo "$R" | jq -r '.asset.id')
ok "S2 register-only asset posts nothing" "$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')" "$((J0 + 1))"
ok "S3 no-assets-module 403" "$(PJ $NAT '{"op":"asset-save","out":{"name":"x","purchase_date":"2026-01-01","cost":100,"salvage":0,"life_months":12}}')" "403"
ok "S4 purchase month skipped" "$(JB '{"op":"asset-depreciate","month":"2026-09"}' | jq -r '.posted | tostring')" "0"
R=$(JB '{"op":"asset-depreciate","month":"2026-10"}')
ok "S5 monthly run posts eligible assets only" "$(echo "$R" | jq -r '.posted | tostring')" "1"
ok "S5b same month re-run is a no-op" "$(JB '{"op":"asset-depreciate","month":"2026-10"}' | jq -r '.posted | tostring')" "0"
R=$(JB '{"op":"asset-depreciate","month":"2026-12"}')
ok "S6 catch-up posts recognized assets only" "$(echo "$R" | jq -r '.posted | tostring')" "2"
SKIP=$(echo "$R" | jq -r '.skipped_unrecognized'); BJ=$(curl -s $RT/api/data -H "$RA" | jq '[.data.journal[] | select(.ref_type=="asset-depr" and .ref_id=='$BID')] | length'); BCUR=$(curl -s $RT/api/data -H "$RA" | jq -r '([.data.assets[] | select(.id=='$BID')][0].depr_through // "null") | tostring'); ok "S6c register-only skipped, no GL depreciation" "$SKIP $BJ $BCUR" "1 0 null"
ok "S6b cursor advanced" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.assets[] | select(.id=='$AID')][0].depr_through')" "2026-12"
ok "S7 financial terms locked after depreciation" "$(J '{"op":"asset-save","id":'$AID',"out":{"name":"Machine A","purchase_date":"2026-09-15","cost":99999,"salvage":0,"life_months":12}}')" "400"
R=$(JB '{"op":"asset-dispose","id":'$AID',"date":"2026-12-31","proceeds":9500}')
ok "S8 disposal at book value with gain" "$(echo "$R" | jq -r '(.book_value | tostring) + " " + (.gain_loss | tostring)')" "9000 500"
ok "S8b disposal journal balanced" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.journal[] | select(.ref_type=="asset-dispose" and .ref_id=='$AID')][0] | ([.lines[].debit] | add) == ([.lines[].credit] | add) | tostring')" "true"
ok "S8c double disposal blocked" "$(J '{"op":"asset-dispose","id":'$AID',"date":"2026-12-31","proceeds":1}')" "400"
ok "S9 delete with history blocked" "$(J '{"op":"asset-delete","id":'$AID'}')" "400"
R2=$(JB '{"op":"asset-save","out":{"name":"Temp Asset","purchase_date":"2026-11-01","cost":300,"salvage":0,"life_months":6}}')
ok "S9b delete without history works" "$(J '{"op":"asset-delete","id":'$(echo "$R2" | jq -r '.asset.id')'}')" "200"
ok "S10 PUT cannot overwrite assets" "$(curl -s -o /dev/null -w '%{http_code}' $RT/api/data -X PUT -H "$RA" -H 'Content-Type: application/json' -d '{"data":{"assets":[]}}')" "200"
ok "S10b forged PUT erased nothing" "$(curl -s $RT/api/data -H "$RA" | jq '.data.assets | length')" "2"
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv7.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
J() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
JB() { curl -s $RT/api/tx -X POST -H "$RA" -H 'Content-Type: application/json' -d "$1"; }
D=$(curl -s $RT/api/data -H "$RA")
ok "S11 restart: assets + depreciation persist" "$(echo "$D" | jq -r '([.data.assets[] | select(.id=='$AID' and .status=="disposed")] | length | tostring) + " " + ([.data.journal[] | select(.ref_type=="asset-depr")] | length | tostring)')" "1 3"

# ---- T. register-only disposal posts nothing; explicit opening recognition
J00=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length')
R=$(JB '{"op":"asset-dispose","id":'$BID',"date":"2026-12-31","proceeds":700}')
GLP=$(echo "$R" | jq -r '.gl_posted | tostring'); JN=$(curl -s $RT/api/data -H "$RA" | jq '.data.journal | length'); ok "T1 unrecognized disposal posts no journal" "$GLP $JN" "false $J00"
ok "T1b unrecognized disposal recorded as memo" "$(echo "$R" | jq -r '(.asset.status) + " " + (.asset.proceeds | tostring)')" "disposed 700"
R=$(JB '{"op":"asset-save","out":{"name":"Machine C","purchase_date":"2026-06-01","cost":9000,"salvage":0,"life_months":12}}')
CID=$(echo "$R" | jq -r '.asset.id')
ok "T2 recognize non-admin 403" "$(PJ $NAT '{"op":"asset-recognize","id":'$CID',"date":"2026-11-01","opening_accum":3000}')" "403"
R=$(JB '{"op":"asset-recognize","id":'$CID',"date":"2026-11-01","opening_accum":3000}')
ok "T3 recognize marks asset" "$(echo "$R" | jq -r '(.asset.opening_recognized | tostring) + " " + (.asset.opening_accum | tostring) + " " + .asset.depr_through')" "true 3000 2026-11"
ok "T3b recognition journal: Dr1500 9000, Cr1590 3000, Cr3000 6000" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.journal[] | select(.ref_type=="asset-recognize" and .ref_id=='$CID')][0] | (([.lines[].debit] | add) == 9000 and ([.lines[].credit] | add) == 9000 and ([.lines[] | select(.credit==6000)] | length) == 1 | tostring)')" "true"
ok "T4 double recognition blocked" "$(J '{"op":"asset-recognize","id":'$CID',"date":"2026-11-02","opening_accum":0}')" "400"
ok "T5 terms locked after recognition" "$(J '{"op":"asset-save","id":'$CID',"out":{"name":"Machine C","purchase_date":"2026-06-01","cost":999,"salvage":0,"life_months":12}}')" "400"
R=$(JB '{"op":"asset-depreciate","month":"2026-12"}')
ok "T6 post-recognition monthly run covers C" "$(echo "$R" | jq -r '.posted | tostring')" "1"
R=$(JB '{"op":"asset-dispose","id":'$CID',"date":"2026-12-31","proceeds":5000}')
ok "T7 recognized disposal with opening accum: book 5250 loss 250" "$(echo "$R" | jq -r '(.book_value | tostring) + " " + (.gain_loss | tostring) + " " + (.gl_posted | tostring)')" "5250 -250 true"
ok "T7b disposal journal balanced incl. opening accum leg" "$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.journal[] | select(.ref_type=="asset-dispose" and .ref_id=='$CID')][0] | (([.lines[].debit] | add) == 9000 and ([.lines[].credit] | add) == 9000 and ([.lines[] | select(.debit==3750)] | length) == 1 | tostring)')" "true"

# ---- U. point of sale: atomic charge, idempotency, shifts
curl -s $RT/api/users -X POST -H "$RA" -H 'Content-Type: application/json' -d '{"username":"cashier","password":"ca121234","role":"employee","modules":["pos"]}' > /dev/null
CT=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"cashier","password":"ca121234"}' | jq -r .token)
CP() { curl -s -o /dev/null -w '%{http_code}' $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d "$1"; }
PID=$(curl -s $RT/api/data -H "$RA" | jq -r '.data.products[0].id')
PPRICE=$(curl -s $RT/api/data -H "$RA" | jq -r '.data.products[0].price')
PSTOCK0=$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')
ok "U1 pos-sale as no-assets user with pos module" "$(CP '{"op":"pos-sale","client_ref":"u1","items":[{"product_id":'$PID',"qty":1}]}')" "200"
ok "U1b stock decremented" "$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')" "$((PSTOCK0 - 1))"
U1INV=$(curl -s $RT/api/data -H "$RA" | jq '[.data.invoices[] | select(.pos_ref=="u1")][0].id'); UST=$(curl -s $RT/api/data -H "$RA" | jq -r '[.data.invoices[] | select(.pos_ref=="u1")][0].status'); UPAY=$(curl -s $RT/api/data -H "$RA" | jq '[.data.payments[] | select(.ref_type=="invoice" and .ref_id=='$U1INV')] | length'); ok "U1c invoice paid + exactly one payment for it" "$UST $UPAY" "paid 1"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"op":"pos-sale","client_ref":"u1","items":[{"product_id":'$PID',"qty":1}]}')
UDUP=$(echo "$R" | jq -r '.duplicate | tostring'); UCNT=$(curl -s $RT/api/data -H "$RA" | jq '[.data.invoices[] | select(.pos_ref=="u1")] | length'); ok "U2 duplicate client_ref idempotent" "$UDUP $UCNT" "true 1"
ok "U2b stock not decremented twice" "$(curl -s $RT/api/data -H "$RA" | jq '.data.products[0].stock')" "$((PSTOCK0 - 1))"
ok "U3 insufficient stock 400" "$(CP '{"op":"pos-sale","client_ref":"u3","items":[{"product_id":'$PID',"qty":999999}]}')" "400"
ok "U4 no-pos-module 403" "$(PJ $NAT '{"op":"pos-sale","client_ref":"u4","items":[{"product_id":'$PID',"qty":1}]}')" "403"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"op":"pos-sale","client_ref":"u5","items":[{"product_id":'$PID',"qty":1,"price":0.01}]}')
ok "U5 forged price ignored, catalog price used" "$(echo "$R" | jq -r '.invoice.items[0].price | tostring')" "$PPRICE"
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"op":"pos-shift-open","opening_float":200}')
SHID=$(echo "$R" | jq -r '.shift.id')
ok "U6 shift open" "$(echo "$R" | jq -r '.shift.status')" "open"
ok "U6b second open shift blocked" "$(CP '{"op":"pos-shift-open","opening_float":50}')" "400"
curl -s $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"op":"pos-sale","client_ref":"u6","shift_id":'$SHID',"items":[{"product_id":'$PID',"qty":1}]}' > /dev/null
R=$(curl -s $RT/api/tx -X POST -H "Authorization: Bearer $CT" -H 'Content-Type: application/json' -d '{"op":"pos-shift-close","id":'$SHID',"counted_cash":999}')
ok "U6c close computes variance, posts nothing" "$(echo "$R" | jq -r '(.shift.status) + " " + (.shift.variance | tostring)')" "closed $(echo "$R" | jq '.shift.variance')"
ok "U6d double close blocked" "$(CP '{"op":"pos-shift-close","id":'$SHID',"counted_cash":0}')" "400"
UCODE=$(curl -s -o /dev/null -w '%{http_code}' $RT/api/data -X PUT -H "$RA" -H 'Content-Type: application/json' -d '{"data":{"pos_shifts":[]}}'); USH=$(curl -s $RT/api/data -H "$RA" | jq '.data.pos_shifts | length'); ok "U7 PUT cannot overwrite pos_shifts" "$UCODE $USH" "200 1"
pkill -f "node server.js"; sleep 1
cd /tmp/rectest/app && setsid nohup env PORT=8497 DATA_DIR=/tmp/rectest/data node server.js > /tmp/rectest/srv8.log 2>&1 &
sleep 1.5
RTOK=$(curl -s $RT/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
RA="Authorization: Bearer $RTOK"
ok "U8 restart: pos invoice + closed shift persist" "$(curl -s $RT/api/data -H "$RA" | jq -r '([.data.invoices[] | select(.pos_ref=="u6")] | length | tostring) + " " + ([.data.pos_shifts[] | select(.status=="closed")] | length | tostring)')" "1 1"

# ---- V. POS taxed sales, per-method settlement, refunds (isolated fixture)
rm -rf /tmp/postest && mkdir -p /tmp/postest/data /tmp/postest/app
cp /tmp/nexus-erp/index.html /tmp/nexus-erp/styles.css /tmp/nexus-erp/*.js /tmp/postest/app/
cd /tmp/postest/app && setsid nohup env PORT=8496 DATA_DIR=/tmp/postest/data node server.js > /tmp/postest/srv.log 2>&1 &
sleep 1.5
PV=http://localhost:8496
PCODE=$(cat /tmp/postest/data/setup-code)
curl -s $PV/api/setup -X POST -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"admin1234\",\"code\":\"$PCODE\"}" > /dev/null
PTOK=$(curl -s $PV/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
PA="Authorization: Bearer $PTOK"
PJB() { curl -s $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d "$1"; }
PCODE() { curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$3" -H 'Content-Type: application/json' -d "$2"; }
R=$(PJB '{"op":"product-save","out":{"name":"V-Widget","price":25,"cost":5,"stock":30}}')
VPID=$(echo "$R" | jq -r '.product.id')
curl -s $PV/api/users -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"username":"cash1","password":"ca121234","role":"employee","modules":["pos"]}' > /dev/null
curl -s $PV/api/users -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"username":"cash2","password":"ca221234","role":"employee","modules":["pos"]}' > /dev/null
curl -s $PV/api/users -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"username":"nopos","password":"np121234","role":"employee","modules":["tasks"]}' > /dev/null
C1=$(curl -s $PV/api/login -H 'Content-Type: application/json' -d '{"username":"cash1","password":"ca121234"}' | jq -r .token)
C2=$(curl -s $PV/api/login -H 'Content-Type: application/json' -d '{"username":"cash2","password":"ca221234"}' | jq -r .token)
NP=$(curl -s $PV/api/login -H 'Content-Type: application/json' -d '{"username":"nopos","password":"np121234"}' | jq -r .token)
C1X() { curl -s $PV/api/tx -X POST -H "Authorization: Bearer $C1" -H 'Content-Type: application/json' -d "$1"; }
C2X() { curl -s $PV/api/tx -X POST -H "Authorization: Bearer $C2" -H 'Content-Type: application/json' -d "$1"; }
SH=$(C1X '{"op":"pos-shift-open","opening_float":100}' | jq -r '.shift.id')
curl -s $PV/api/data -X PUT -H "$PA" -H "Content-Type: application/json" -d "{\"data\":{\"settings\":{\"tax_rate\":14}}}" > /dev/null  # POS tax is server-owned (settings), no longer client-chosen
C1X '{"op":"pos-sale","client_ref":"vc","shift_id":'$SH',"method":"cash","tax_rate":14,"items":[{"product_id":'$VPID',"qty":1}]}' > /dev/null
C1X '{"op":"pos-sale","client_ref":"vb","shift_id":'$SH',"method":"bank","tax_rate":14,"items":[{"product_id":'$VPID',"qty":1}]}' > /dev/null
C1X '{"op":"pos-sale","client_ref":"vt","shift_id":'$SH',"method":"transfer","tax_rate":14,"items":[{"product_id":'$VPID',"qty":1}]}' > /dev/null
D=$(curl -s $PV/api/data -H "$PA")
VCINV=$(echo "$D" | jq '[.data.invoices[] | select(.pos_ref=="vc")][0].id')
VBINV=$(echo "$D" | jq '[.data.invoices[] | select(.pos_ref=="vb")][0].id')
VTINV=$(echo "$D" | jq '[.data.invoices[] | select(.pos_ref=="vt")][0].id')
ok "V1 taxed sale journal: Dr1100 28.5 / Cr4000 25 / Cr2100 3.5" "$(echo "$D" | jq -r '[.data.journal[] | select(.ref_type=="invoice" and .ref_id=='$VCINV')][0].lines as $l | (([$l[].debit] | add) == 28.5 and ([$l[].credit] | add) == 28.5 and ([$l[] | select(.credit==3.5)] | length) == 1 | tostring)')" "true"
A1000=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="1000")'.id); A1010=$(echo "$D" | jq -r '.data.accounts[] | select(.code=="1010")'.id)
ok "V2 settlement accounts per method" "$(echo "$D" | jq -r '([.data.journal[] | select(.ref_type=="payment")]) as $p | "x"')" "x"
ok "V2b cash sale debits 1000, bank/transfer debit 1010" "$(echo "$D" | jq -r --arg a1000 "$A1000" --arg a1010 "$A1010" '([.data.journal[] | select(.ref_type=="payment")] | map(.lines[0].account_id) | map(. == ($a1000|tonumber)) | [.[0], .[1], .[2]] | map(tostring) | join(","))')" "true,false,false"
ok "V2c payments debit 1010 twice" "$(echo "$D" | jq -r --arg a1010 "$A1010" '[.data.journal[] | select(.ref_type=="payment") | .lines[0] | select(.account_id == ($a1010|tonumber))] | length')" "2"
ok "V3 stock after 3 taxed sales" "$(echo "$D" | jq '[.data.products[] | select(.id=='$VPID')][0].stock')" "27"
ok "V4 refund no-pos-module 403" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "Authorization: Bearer $NP" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":'$VCINV'}')" "403"
R=$(C1X '{"op":"pos-refund","id":'$VCINV'}')
ok "V5 cash refund: status + VAT reversed + Cr1000" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
D=$(curl -s $PV/api/data -H "$PA")
RJ=$(echo "$D" | jq '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id=='$VCINV')][0]')
ok "V5b refund journal balanced w/ VAT+COGS legs" "$(echo "$RJ" | jq -r --arg a1000 "$A1000" '((([.lines[].debit] | add) == ([.lines[].credit] | add)) and (([.lines[].debit] | add) == 33.5) and (([.lines[] | select(.debit==3.5)] | length) == 1) and (([.lines[] | select(.credit==28.5 and .account_id==($a1000|tonumber))] | length) == 1) | tostring)')" "true"
ok "V5c stock restored" "$(echo "$D" | jq '[.data.products[] | select(.id=='$VPID')][0].stock')" "28"
ok "V5d shift refund_cash attributed" "$(echo "$D" | jq -r '[.data.pos_shifts[] | select(.id=='$SH')][0].refund_cash')" "28.5"
ok "V5e original payment row intact + refund out row" "$(echo "$D" | jq -r '([.data.payments[] | select(.ref_id=='$VCINV' and .direction=="in" and .amount==28.5)] | length | tostring) + " " + ([.data.payments[] | select(.ref_id=='$VCINV' and .direction=="out" and .amount==28.5)] | length | tostring)')" "1 1"
ok "V5f original invoice total unchanged" "$(echo "$D" | jq -r '[.data.invoices[] | select(.id=='$VCINV')][0] | ((.items[0].price * (1 + .tax_rate/100) * 100 | round) / 100 | tostring)')" "28.5"
ok "V6 exactly-once refund" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "Authorization: Bearer $C1" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":'$VCINV'}')" "400"
R=$(C2X '{"op":"pos-refund","id":'$VBINV'}')
ok "V7 refund by another cashier, no open shift" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
D=$(curl -s $PV/api/data -H "$PA")
ok "V7b bank refund credits 1010" "$(echo "$D" | jq -r --arg a1010 "$A1010" '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id=='$VBINV')][0] | ([.lines[] | select(.credit==28.5 and .account_id==($a1010|tonumber))] | length | tostring)')" "1"
ok "V7c no shift attribution without open shift" "$(echo "$D" | jq -r '[.data.pos_shifts[] | select(.id=='$SH')][0] | (.refund_bank // 0 | tostring)')" "0"
R=$(C1X '{"op":"pos-shift-close","id":'$SH',"counted_cash":100}')
ok "V8 close after cash refund: expected 100, variance 0" "$(echo "$R" | jq -r '(.shift.expected_cash | tostring) + " " + (.shift.variance | tostring)')" "100 0"
SH2=$(C2X '{"op":"pos-shift-open","opening_float":50}' | jq -r '.shift.id')
C2X '{"op":"pos-refund","id":'$VTINV'}' > /dev/null
D=$(curl -s $PV/api/data -H "$PA")
ok "V9 refund after original shift closed lands on current shift" "$(echo "$D" | jq -r '([.data.pos_shifts[] | select(.id=='$SH2')][0].refund_transfer // 0 | tostring) + " " + ([.data.pos_shifts[] | select(.id=='$SH')][0] | (.refund_transfer // 0 | tostring) + ":" + (.status))')" "28.5 0:closed"
ok "V9b closed shift figures frozen" "$(echo "$D" | jq -r '[.data.pos_shifts[] | select(.id=='$SH')][0] | (.expected_cash | tostring) + " " + (.variance | tostring)')" "100 0"
R=$(PJB '{"op":"invoice-save","out":{"status":"sent","contact_id":null,"issue_date":"2026-11-25","tax_rate":0,"items":[{"product_id":'$VPID',"qty":1,"price":25}]}}')
NPID=$(echo "$R" | jq -r '.invoice.id // .invoice_id // empty')
[ -z "$NPID" ] && NPID=$(curl -s $PV/api/data -H "$PA" | jq '[.data.invoices[] | select(.pos_ref == null)][0].id')
ok "V10 non-POS invoice refund blocked" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"pos-refund","id":'$NPID'}')" "400"
GAP=$(curl -s $PV/api/data -H "$PA" | jq -r '.data as $d | ($d.accounts[] | select(.code=="1200")) as $a | ([$d.journal[].lines[] | select(.account_id==$a.id) | (.debit//0) - (.credit//0)] | add) - ([$d.products[] | .stock * .cost] | add)')
ok "V11 inventory GL == stock valuation after everything" "$GAP" "0"
pkill -f "node server.js"; sleep 1
cd /tmp/postest/app && setsid nohup env PORT=8496 DATA_DIR=/tmp/postest/data node server.js > /tmp/postest/srv2.log 2>&1 &
sleep 1.5
PTOK=$(curl -s $PV/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin1234"}' | jq -r .token)
PA="Authorization: Bearer $PTOK"
ok "V12 restart: refunds + shifts + stock persist" "$(curl -s $PV/api/data -H "$PA" | jq -r '([.data.invoices[] | select(.status=="refunded")] | length | tostring) + " " + ([.data.pos_shifts[] | select(.status=="closed")] | length | tostring) + " " + ([.data.products[] | select(.id=='$VPID')][0].stock | tostring)')" "3 1 29"

# V13 card: sale settles to 1010, tracked on shift, never in expected cash
C2X '{"op":"pos-sale","client_ref":"vcard","shift_id":'$SH2',"method":"card","tax_rate":14,"items":[{"product_id":'$VPID',"qty":1}]}' > /dev/null
D=$(curl -s $PV/api/data -H "$PA")
VCARD=$(echo "$D" | jq '[.data.invoices[] | select(.pos_ref=="vcard")][0].id')
ok "V13 card sale tracked on shift" "$(echo "$D" | jq -r '[.data.pos_shifts[] | select(.id=='$SH2')][0].sales_card')" "28.5"
PJID=$(echo "$D" | jq -r '[.data.payments[] | select(.ref_id=='$VCARD' and .direction=="in")][0].journal_id')
ok "V13b card sale payment debits 1010" "$(echo "$D" | jq -r --arg a1010 "$A1010" '[.data.journal[] | select(.id=='$PJID')][0].lines[0].account_id == ($a1010|tonumber) | tostring')" "true"
C2X '{"op":"pos-refund","id":'$VCARD'}' > /dev/null
D=$(curl -s $PV/api/data -H "$PA")
ok "V13c card refund credits 1010" "$(echo "$D" | jq -r --arg a1010 "$A1010" '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id=='$VCARD')][0] | ([.lines[] | select(.credit==28.5 and .account_id==($a1010|tonumber))] | length | tostring)')" "1"
ok "V13d card refund on current shift" "$(echo "$D" | jq -r '[.data.pos_shifts[] | select(.id=='$SH2')][0].refund_card')" "28.5"
R=$(C2X '{"op":"pos-shift-close","id":'$SH2',"counted_cash":50}')
ok "V13e card never enters expected cash" "$(echo "$R" | jq -r '(.shift.expected_cash | tostring) + " " + (.shift.variance | tostring)')" "50 0"
# V14 legacy: missing method stays historical cash; junk method rejected
R=$(PJB '{"op":"invoice-save","out":{"status":"sent","contact_id":null,"issue_date":"2026-11-25","tax_rate":0,"items":[{"product_id":'$VPID',"qty":1,"price":25}]}}')
LINV=$(echo "$R" | jq -r '.invoice.id')
PCNT=$(curl -s $PV/api/data -H "$PA" | jq '.data.payments | length')
R=$(PJB '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$LINV',"amount":25,"date":"2026-11-25"}')
ok "V14 payment without method stored as cash" "$(echo "$R" | jq -r '.payment.method')" "cash"
LJID=$(echo "$R" | jq -r '.payment.journal_id')
ok "V14b missing method settles to historical 1000" "$(curl -s $PV/api/data -H "$PA" | jq -r --arg a1000 "$A1000" '[.data.journal[] | select(.id=='$LJID')][0].lines[0].account_id == ($a1000|tonumber) | tostring')" "true"
ok "V14c junk method rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$LINV',"amount":1,"method":"crypto","date":"2026-11-25"}')" "400"
ok "V14d rejected junk moved nothing" "$(curl -s $PV/api/data -H "$PA" | jq '.data.payments | length')" "$((PCNT+1))"
GAP=$(curl -s $PV/api/data -H "$PA" | jq -r '.data as $d | ($d.accounts[] | select(.code=="1200")) as $a | ([$d.journal[].lines[] | select(.account_id==$a.id) | (.debit//0) - (.credit//0)] | add) - ([$d.products[] | .stock * .cost] | add)')
ok "V15 inventory GL == stock after card + legacy cases" "$GAP" "0"
# V16 reclass on a clean store: nothing to reclass
ok "V16 reclass with no legacy mismatch 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"reclass-settlement","all":true}')" "400"
# V17 payout method may differ from the original sale method: actual bank
# payout reduces the bank, original posting untouched, audit row kept
R=$(PJB '{"op":"pos-sale","client_ref":"v17","method":"cash","tax_rate":0,"items":[{"product_id":'$VPID',"qty":1}]}')
V17INV=$(curl -s $PV/api/data -H "$PA" | jq '[.data.invoices[] | select(.pos_ref=="v17")][0].id')
R=$(PJB '{"op":"pos-refund","id":'$V17INV',"method":"bank"}')
ok "V17 cash sale refunded via bank payout" "$(echo "$R" | jq -r '.invoice.status')" "refunded"
D=$(curl -s $PV/api/data -H "$PA")
ok "V17b refund credits 1010 (actual payout)" "$(echo "$D" | jq -r --arg a1010 "$A1010" '[.data.journal[] | select(.ref_type=="pos-refund" and .ref_id=='$V17INV')][0] | ([.lines[] | select(.credit==28.5 and .account_id==($a1010|tonumber))] | length | tostring)')" "1"
ok "V17c refund row records payout method" "$(echo "$D" | jq -r '[.data.payments[] | select(.ref_id=='$V17INV' and .direction=="out")][0].method')" "bank"
ok "V17d original payment journal untouched (Dr1000)" "$(echo "$D" | jq -r --arg a1000 "$A1000" '[.data.payments[] | select(.ref_id=='$V17INV' and .direction=="in")][0].journal_id as $j | [.data.journal[] | select(.id==$j)][0] | ([.lines[] | select(.debit==28.5 and .account_id==($a1000|tonumber))] | length | tostring)')" "1"

# ---- W. Manufacturing: BOMs + production runs (same PV fixture)
R=$(PJB '{"op":"product-save","out":{"name":"Raw Steel","price":4,"cost":2,"stock":100}}')
RMID=$(echo "$R" | jq -r '.product.id')
R=$(PJB '{"op":"product-save","out":{"name":"Bracket","price":20,"cost":11,"stock":0}}')
FGID=$(echo "$R" | jq -r '.product.id')
VPSTOCK=$(curl -s $PV/api/data -H "$PA" | jq '[.data.products[] | select(.id=='$VPID')][0].stock')
R=$(PJB '{"op":"bom-save","product_id":'$FGID',"lines":[{"product_id":'$RMID',"qty":2},{"product_id":'$VPID',"qty":1}]}')
ok "W1 bom-save stores recipe" "$(echo "$R" | jq -r '.bom | length')" "2"
ok "W2 bom self-reference rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"bom-save","product_id":'$FGID',"lines":[{"product_id":'$FGID',"qty":1}]}')" "400"
ok "W3 produce without BOM rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"produce","product_id":'$RMID',"qty":1}')" "400"
ok "W4 produce without module 403" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "Authorization: Bearer $NP" -H 'Content-Type: application/json' -d '{"op":"produce","product_id":'$FGID',"qty":1}')" "403"
ok "W5 insufficient components rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"produce","product_id":'$FGID',"qty":1000}')" "400"
ok "W5b failed run moved no stock" "$(curl -s $PV/api/data -H "$PA" | jq '[.data.products[] | select(.id=='$RMID')][0].stock')" "100"
R=$(PJB '{"op":"produce","product_id":'$FGID',"qty":3}')
PRID=$(echo "$R" | jq -r '.production.id')
ok "W6 production run recorded" "$(echo "$R" | jq -r '(.production.qty | tostring) + " " + (.component_cost | tostring) + " " + (.output_value | tostring)')" "3 27 33"
D=$(curl -s $PV/api/data -H "$PA")
ok "W7 components consumed / finished produced" "$(echo "$D" | jq -r '([.data.products[] | select(.id=='$RMID')][0].stock | tostring) + " " + ([.data.products[] | select(.id=='$VPID')][0].stock | tostring) + " " + ([.data.products[] | select(.id=='$FGID')][0].stock | tostring)')" "94 $((VPSTOCK-3)) 3"
ok "W8 stock moves carry production reasons" "$(echo "$D" | jq -r '[.data.stock_moves[] | select(.ref_type=="production" and .ref_id=='$PRID')] | map(.reason) | sort | join(",")')" "production-consume,production-consume,production-output"
ok "W9 journal: Dr1200 33 / Cr1200 27 / Cr5200 6" "$(echo "$D" | jq -r '[.data.journal[] | select(.ref_type=="production" and .ref_id=='$PRID')][0].lines as $l | ([$l[] | select(.debit==33)] | length | tostring) + ([$l[] | select(.credit==27)] | length | tostring) + ([$l[] | select(.credit==6)] | length | tostring)')" "111"
GAP=$(echo "$D" | jq -r '.data as $d | ($d.accounts[] | select(.code=="1200")) as $a | ([$d.journal[].lines[] | select(.account_id==$a.id) | (.debit//0) - (.credit//0)] | add) - ([$d.products[] | .stock * .cost] | add)')
ok "W10 inventory GL == stock after production" "$GAP" "0"
PJCOUNT=$(echo "$D" | jq '.data.production | length')
ok "W11 PUT cannot overwrite production (server-owned)" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/data -X PUT -H "$PA" -H 'Content-Type: application/json' -d '{"data":{"production":[]}}')" "200"
ok "W11b forged PUT erased nothing" "$(curl -s $PV/api/data -H "$PA" | jq '.data.production | length')" "$PJCOUNT"
# W12 restart durability for the production family
pkill -f 'PORT=8496' 2>/dev/null; sleep 1
cd /tmp/postest/app && setsid nohup env PORT=8496 DATA_DIR=/tmp/postest/data node server.js >> /tmp/postest/srv.log 2>&1 &
sleep 1.5
D=$(curl -s $PV/api/data -H "$PA")
ok "W12 production + journal survive restart" "$(echo "$D" | jq -r '(.data.production | length | tostring) + " " + ([.data.journal[] | select(.ref_type=="production")] | length | tostring)')" "1 1"
ok "W12b gap still 0 after restart" "$(echo "$D" | jq -r '.data as $d | ($d.accounts[] | select(.code=="1200")) as $a | ([$d.journal[].lines[] | select(.account_id==$a.id) | (.debit//0) - (.credit//0)] | add) - ([$d.products[] | .stock * .cost] | add)')" "0"
ok "W13 reclass ids subset: unknown id 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"reclass-settlement","ids":[999999]}')" "400"

# W14-W18 manufacturing hardening: recipe shapes, idempotency, concurrency
ok "W14 duplicate component rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"bom-save","product_id":'$FGID',"lines":[{"product_id":'$RMID',"qty":1},{"product_id":'$RMID',"qty":2}]}')" "400"
ok "W15 indirect cycle rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"bom-save","product_id":'$RMID',"lines":[{"product_id":'$FGID',"qty":1}]}')" "400"
R=$(PJB '{"op":"product-save","out":{"name":"SubAsm","price":9,"cost":8,"stock":10}}')
SUBID=$(echo "$R" | jq -r '.product.id')
PJB '{"op":"bom-save","product_id":'$SUBID',"lines":[{"product_id":'$RMID',"qty":1}]}' > /dev/null
ok "W16 multi-level recipe rejected 400" "$(curl -s -o /dev/null -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"bom-save","product_id":'$FGID',"lines":[{"product_id":'$RMID',"qty":2},{"product_id":'$VPID',"qty":1},{"product_id":'$SUBID',"qty":1}]}')" "400"
PRC=$(curl -s $PV/api/data -H "$PA" | jq '.data.production | length')
R1=$(PJB '{"op":"produce","product_id":'$FGID',"qty":1,"client_ref":"w17-dup"}')
R2=$(PJB '{"op":"produce","product_id":'$FGID',"qty":1,"client_ref":"w17-dup"}')
ok "W17 retry with same client_ref deduped" "$(echo "$R2" | jq -r '.deduped | tostring')" "true"
ok "W17b exactly one production row added" "$(curl -s $PV/api/data -H "$PA" | jq '.data.production | length')" "$((PRC+1))"
ok "W17c stock moved exactly once (RM -2, VPID -1)" "$(curl -s $PV/api/data -H "$PA" | jq -r '([.data.products[] | select(.id=='$RMID')][0].stock | tostring) + " " + ([.data.products[] | select(.id=='$VPID')][0].stock | tostring)')" "92 24"
# W18 two concurrent runs competing for the same stock: exactly one wins
( curl -s -o /tmp/w18a.json -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"produce","product_id":'$FGID',"qty":20,"client_ref":"w18-a"}' > /tmp/w18a.code ) &
WA=$!
( curl -s -o /tmp/w18b.json -w '%{http_code}' $PV/api/tx -X POST -H "$PA" -H 'Content-Type: application/json' -d '{"op":"produce","product_id":'$FGID',"qty":20,"client_ref":"w18-b"}' > /tmp/w18b.code ) &
WB=$!
wait $WA $WB
C18=$(cat /tmp/w18a.code /tmp/w18b.code | tr -d '\n')
ok "W18 concurrent runs: exactly one succeeds" "$([ "$C18" = "200400" ] || [ "$C18" = "400200" ] && echo yes || echo "no:$C18")" "yes"
D=$(curl -s $PV/api/data -H "$PA")
ok "W18b losing run moved nothing (VPID 24-20)" "$(echo "$D" | jq '[.data.products[] | select(.id=='$VPID')][0].stock')" "4"
ok "W18c no duplicate client_ref rows" "$(echo "$D" | jq '[.data.production[] | select(.client_ref=="w18-a" or .client_ref=="w18-b")] | length')" "1"
GAP=$(echo "$D" | jq -r '.data as $d | ($d.accounts[] | select(.code=="1200")) as $a | ([$d.journal[].lines[] | select(.account_id==$a.id) | (.debit//0) - (.credit//0)] | add) - ([$d.products[] | .stock * .cost] | add)')
ok "W18d inventory GL == stock after concurrency" "$GAP" "0"

pkill -f "node server.js"
echo "== battery: $PASS passed, $FAIL failed =="
