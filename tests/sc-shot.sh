B=http://localhost:8497; D=/tmp/scshot; H="Content-Type: application/json"
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8497 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"admin\",\"password\":\"admin1234\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"admin","password":"admin1234"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"مورد الاختبار"}]}}'
PID=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":0}}' | jq .product.id)
P1=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PID',"qty":5,"cost":10}]}}' | jq .purchase.id)
tx '{"op":"payment","direction":"out","ref_type":"purchase","ref_id":'$P1',"amount":50,"method":"bank"}' >/dev/null
tx '{"op":"purchase-return-create","purchase_id":'$P1',"reason":"defective batch","items":[{"line":0,"qty":5}],"store_credit":true}' | jq -c .purchase_return.store_credit
P2=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PID',"qty":3,"cost":10}]}}' | jq .purchase.id)
SCID=$(curl -s $B/api/data -H "$A" | jq '.data.supplier_credits[0].id')
tx '{"op":"supplier-credit-apply","credit_id":'$SCID',"purchase_id":'$P2',"amount":20}' | jq -c '.supplier_credit.remaining'
cd /tmp/ts
node app-shot2.js $B purchases /downloads/h16-purchases-supplier-credit.png 1440 1500 | grep -E "MEASURE|SHOT"
pkill -f "node server.js"
