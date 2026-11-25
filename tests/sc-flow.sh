B=http://localhost:8497; D=/tmp/scflow; H="Content-Type: application/json"
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8497 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"admin\",\"password\":\"admin1234\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"admin","password":"admin1234"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"مورد الاختبار"}]}}'
PID=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":0}}' | jq .product.id)
P1=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PID',"qty":5,"cost":10}]}}' | jq .purchase.id)
tx '{"op":"payment","direction":"out","ref_type":"purchase","ref_id":'$P1',"amount":50,"method":"bank"}' >/dev/null
tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PID',"qty":3,"cost":10}]}}' >/dev/null
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"مورد الاختبار"}],"contacts":[{"id":555,"first_name":"عميل","last_name":"تجريبي"}]}}'
CI=$(tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-06","due_date":"2026-12-01","tax_rate":0,"items":[{"description":"service","qty":1,"price":100}]}}' | jq .invoice.id)
tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$CI',"amount":100,"method":"bank"}' >/dev/null
tx '{"op":"credit-note-create","invoice_id":'$CI',"reason":"overpaid","items":[{"line":0,"qty":1}],"store_credit":true}' >/dev/null
tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-07","due_date":"2026-12-01","tax_rate":0,"items":[{"description":"service 2","qty":1,"price":60}]}}' >/dev/null
cd /tmp/ts; node flow-shot.js $B purchases /tmp/x.png 1440 1500 2>&1 | grep -v "^MEASURE"
pkill -f "node server.js"
