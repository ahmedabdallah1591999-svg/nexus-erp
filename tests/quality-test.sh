#!/bin/bash
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8496; D=/tmp/qtest; H='Content-Type: application/json'
pkill -f "node server.js" 2>/dev/null; sleep 1; rm -rf $D; mkdir -p $D/data
cd /tmp/nexus-erp
# existing-style store WITHOUT the new collections/seqs: must upgrade without reset
echo '{"users":[],"data":{"meta":{"nextId":5,"ticketSeq":1},"products":[{"id":3,"name":"Old Widget","price":5,"cost":2,"stock":9}],"contacts":[],"companies":[],"settings":{}}}' > $D/data/store.json
setsid nohup env PORT=8496 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &
sleep 1.5
SC=$(cat $D/data/setup-code)
curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"boss\",\"password\":\"b0ss-pass-1\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"boss","password":"b0ss-pass-1"}' | jq -r .token); A="Authorization: Bearer $TOK"
ok "U1 old product survived upgrade" "$(curl -s $B/api/data -H "$A" | jq '.data.products[0].name' -r)" "Old Widget"
ok "U2 new collections exist empty" "$(curl -s $B/api/data -H "$A" | jq '(.data.quality_checks|length)+(.data.documents|length)')" "0"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
txc(){ curl -s -o /dev/null -w '%{http_code}' $B/api/tx -X POST -H "$2" -H "$H" -d "$1"; }
R=$(tx '{"op":"qc-save","out":{"title":"Incoming widgets","type":"incoming","product_id":3,"qty_inspected":10,"result":"pass","status":"closed","created_by":"mallory","number":"QC-9999"}}')
ok "Q1 number server-assigned" "$(echo $R | jq -r .check.number)" "QC-0001"
ok "Q2 forged result/status/creator ignored" "$(echo $R | jq -r '.check.result+","+.check.status+","+.check.created_by')" "pending,open,boss"
ID=$(echo $R | jq .check.id)
ok "Q3 zero qty rejected" "$(txc '{"op":"qc-save","out":{"title":"x","qty_inspected":0}}' "$A")" "400"
ok "Q4 unknown product rejected" "$(txc '{"op":"qc-save","out":{"title":"x","qty_inspected":1,"product_id":999}}' "$A")" "400"
ok "Q5 fail qty above inspected rejected" "$(txc '{"op":"qc-result","id":'$ID',"result":"fail","qty_failed":11}' "$A")" "400"
ok "Q6 close before result rejected" "$(txc '{"op":"qc-close","id":'$ID',"corrective_action":"fixed it all"}' "$A")" "400"
R=$(tx '{"op":"qc-result","id":'$ID',"result":"fail","qty_failed":3}')
ok "Q7 fail recorded stays open" "$(echo $R | jq -r '.check.result+","+.check.status+","+(.check.qty_failed|tostring)')" "fail,open,3"
ok "Q8 close without corrective action rejected" "$(txc '{"op":"qc-close","id":'$ID',"corrective_action":""}' "$A")" "400"
R=$(tx '{"op":"qc-close","id":'$ID',"corrective_action":"Returned lot to supplier"}')
ok "Q9 closed with corrective action" "$(echo $R | jq -r .check.status)" "closed"
ok "Q10 closed record cannot change result" "$(txc '{"op":"qc-result","id":'$ID',"result":"pass"}' "$A")" "400"
R=$(tx '{"op":"qc-save","out":{"title":"Pass case","qty_inspected":5}}'); ID2=$(echo $R | jq .check.id)
R=$(tx '{"op":"qc-result","id":'$ID2',"result":"pass"}')
ok "Q11 pass closes" "$(echo $R | jq -r .check.status)" "closed"
ok "Q12 stock untouched by inspection (no auto-adjustment)" "$(curl -s $B/api/data -H "$A" | jq '.data.products[0].stock')" "9"
ok "Q13 no journal rows created" "$(curl -s $B/api/data -H "$A" | jq '(.data.journal|length)+(.data.ledger|length)')" "0"
# permissions
curl -s $B/api/users -X POST -H "$A" -H "$H" -d '{"username":"qa1","password":"qa1-pass-99","role":"employee","modules":["quality"]}' > /dev/null
curl -s $B/api/users -X POST -H "$A" -H "$H" -d '{"username":"nq","password":"nq-pass-9999","role":"employee","modules":["contacts"]}' > /dev/null
QT=$(curl -s $B/api/login -H "$H" -d '{"username":"qa1","password":"qa1-pass-99"}' | jq -r .token); QA="Authorization: Bearer $QT"
NT=$(curl -s $B/api/login -H "$H" -d '{"username":"nq","password":"nq-pass-9999"}' | jq -r .token); NA="Authorization: Bearer $NT"
ok "P1 no-quality user blocked on tx" "$(txc '{"op":"qc-save","out":{"title":"x","qty_inspected":1}}' "$NA")" "403"
ok "P2 no-quality user cannot read collections" "$(curl -s $B/api/data -H "$NA" | jq '(.data.quality_checks//[]|length)+(.data.documents//[]|length)')" "0"
ok "P3 client PUT cannot inject checks" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"quality_checks":[{"id":777,"number":"QC-FAKE"}],"documents":[{"id":778,"number":"DOC-FAKE"}]}}')$(curl -s $B/api/data -H "$A" | jq '[.data.quality_checks[]|select(.number=="QC-FAKE")]|length')" "2000"
ok "P4 non-admin cannot delete inspected record" "$(txc '{"op":"qc-delete","id":'$ID'}' "$QA")" "400"
# documents
R=$(txc '{"op":"doc-save","out":{"title":"x"}}' "$QA"); ok "D0 quality user can create doc" "$R" "200"
R=$(tx '{"op":"doc-save","out":{"title":"Safety procedure","doc_type":"procedure","owner":"mallory","version":9,"status":"approved"}}')
ok "D1 forged owner/version/status ignored" "$(echo $R | jq -r '.document.owner+",v"+(.document.version|tostring)+","+.document.status')" "boss,v1,draft"
DID=$(echo $R | jq .document.id)
ok "D2 cannot jump draft->approved" "$(txc '{"op":"doc-status","id":'$DID',"status":"approved"}' "$A")" "400"
tx '{"op":"doc-status","id":'$DID',"status":"review"}' > /dev/null
ok "D3 owner cannot approve own doc" "$(txc '{"op":"doc-status","id":'$DID',"status":"approved"}' "$A")" "400"
ok "D4 different user approves" "$(txc '{"op":"doc-status","id":'$DID',"status":"approved"}' "$QA")" "200"
ok "D5 approved doc locked from edit" "$(txc '{"op":"doc-save","id":'$DID',"out":{"title":"changed"}}' "$A")" "400"
ok "D6 revise needs note" "$(txc '{"op":"doc-revise","id":'$DID',"note":""}' "$A")" "400"
R=$(tx '{"op":"doc-revise","id":'$DID',"note":"Added step 4"}')
ok "D7 revise bumps version, back to draft, approval cleared" "$(echo $R | jq -r '"v"+(.document.version|tostring)+","+.document.status+","+(.document.approved_by//"none")')" "v2,draft,none"
ok "D8 history keeps all entries" "$(echo $R | jq '.document.history|length')" "4"
ok "D9 non-admin cannot delete beyond draft (approved→n/a, review)" "$(txc '{"op":"doc-delete","id":9999}' "$A")" "400"

# --- review round: history protection, quantities, atomicity, allowlist
ok "H1 admin cannot hard-delete an inspected record" "$(txc '{"op":"qc-delete","id":'$ID'}' "$A")" "400"
ok "H2 non-admin cannot void" "$(txc '{"op":"qc-void","id":'$ID',"reason":"mistake in record"}' "$QA")" "400"
ok "H3 void needs a reason" "$(txc '{"op":"qc-void","id":'$ID',"reason":"x"}' "$A")" "400"
R=$(tx '{"op":"qc-void","id":'$ID',"reason":"Wrong lot recorded"}')
ok "H4 void keeps record, flags and attributes it" "$(echo $R | jq -r '.check|((.voided|tostring)+","+.voided_by+","+.result+","+.corrective_action)')" "true,boss,fail,Returned lot to supplier"
ok "H5 voided record still present" "$(curl -s $B/api/data -H "$A" | jq '[.data.quality_checks[]|select(.id=='$ID')]|length')" "1"
ok "H6 void twice rejected" "$(txc '{"op":"qc-void","id":'$ID',"reason":"Wrong lot recorded"}' "$A")" "400"
ok "H7 doc with history cannot be deleted" "$(txc '{"op":"doc-delete","id":'$DID'}' "$A")" "400"
R=$(tx '{"op":"doc-save","out":{"title":"Throwaway draft"}}'); TD=$(echo $R | jq .document.id)
ok "H8 untouched v1 draft can be deleted by owner" "$(txc '{"op":"doc-delete","id":'$TD'}' "$A")" "200"
for BAD in '"1e999"' 'true' '"abc"' '[1]' '-1' '0' 'null' '"  "' '1000000001' '"1,5"' '{}'; do
  ok "N qty $BAD rejected" "$(txc '{"op":"qc-save","out":{"title":"q","qty_inspected":'"$BAD"'}}' "$A")" "400"
done
R=$(tx '{"op":"qc-save","out":{"title":"Valid qty","qty_inspected":"12.5"}}'); QV=$(echo $R | jq .check.id)
ok "N2 numeric string accepted as number" "$(echo $R | jq .check.qty_inspected)" "12.5"
for BAD in '"1e999"' 'true' '13' '0' '"x"'; do
  ok "N3 failed qty $BAD rejected" "$(txc '{"op":"qc-result","id":'$QV',"result":"fail","qty_failed":'"$BAD"'}' "$A")" "400"
done
# malicious payload: extra money/stock fields must have no effect
S0=$(curl -s $B/api/data -H "$A" | jq -c '[.data.products,.data.journal,.data.ledger,.data.accounts,.data.invoices,.data.stock_moves]' | sha256sum)
tx '{"op":"qc-save","out":{"title":"evil","qty_inspected":1,"stock":99999,"price":0,"journal":[{"id":1}],"products":[],"meta":{"nextId":1}},"stock":5,"data":{"products":[]}}' > /dev/null
S1=$(curl -s $B/api/data -H "$A" | jq -c '[.data.products,.data.journal,.data.ledger,.data.accounts,.data.invoices,.data.stock_moves]' | sha256sum)
ok "M1 malicious extra fields leave money/stock/books byte-identical" "$S1" "$S0"
# rejected write atomicity: whole store file unchanged after rejected ops
F0=$(sha256sum $D/data/store.json | cut -d' ' -f1)
txc '{"op":"qc-result","id":'$QV',"result":"fail","qty_failed":999}' "$A" >/dev/null
txc '{"op":"doc-status","id":'$DID',"status":"obsolete"}' "$A" >/dev/null
F1=$(sha256sum $D/data/store.json | cut -d' ' -f1)
ok "M2 rejected ops leave store.json byte-identical" "$F1" "$F0"
# allowlist guard: a rogue nonFinancial op that touches products/meta is rejected and not committed
cat > /tmp/qguard.js <<'JS'
const tx = require('/tmp/nexus-erp/tx.js');
const mk = () => ({ users: [], data: { meta: { nextId: 10, qcSeq: 1, docSeq: 1 }, products: [{ id: 1, name: 'W', stock: 5, cost: 2, price: 3 }], quality_checks: [], documents: [], contacts: [], companies: [], settings: {} } });
const can = () => true;
const out = [];
for (const [name, fn] of Object.entries({
  products: ctx => { ctx.store.data.products[0].stock = 9999; },
  meta: ctx => { ctx.store.data.meta.purchaseSeq = 99; },
  settings: ctx => { ctx.store.data.settings.x = 1; },
  newcoll: ctx => { ctx.store.data.journal = [{ id: 1 }]; },
  allowed: ctx => { ctx.store.data.quality_checks.push({ id: 1 }); ctx.store.data.meta.qcSeq++; },
})) {
  tx.OPS['rogue-' + name] = { view: 'quality', nonFinancial: true, run(ctx) { fn(ctx); return {}; } };
  const db = mk(); const before = JSON.stringify(db);
  const r = tx.runTx(db, { username: 'u', role: 'admin' }, 'rogue-' + name, {}, can);
  out.push(name + ':' + (r.ok ? 'ok' : 'rejected') + ':' + (JSON.stringify(db) === before ? 'unchanged' : 'changed'));
}
console.log(out.join(' '));
JS
G=$(node /tmp/qguard.js)
ok "G1 allowlist: products/meta/settings/new collection writes rejected, db untouched; allowed write commits" "$G" "products:rejected:unchanged meta:rejected:unchanged settings:rejected:unchanged newcoll:rejected:unchanged allowed:ok:changed"
pkill -f "node server.js"
echo "quality-test: PASS=$PASS FAIL=$FAIL"
