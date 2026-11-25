B=http://localhost:8497; D=/tmp/recvshot; H='Content-Type: application/json'
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8497 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"admin\",\"password\":\"admin1234\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"admin","password":"admin1234"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"مورد الاختبار"}]}}'
P1=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":0}}' | jq .product.id)
P2=$(tx '{"op":"product-save","out":{"name":"Gadget","price":20,"cost":5,"stock":0}}' | jq .product.id)
PO=$(tx '{"op":"purchase-save","out":{"status":"ordered","supplier_id":777,"items":[{"product_id":'$P1',"qty":10,"cost":10},{"product_id":'$P2',"qty":4,"cost":5}]}}' | jq .purchase.id)
tx '{"op":"purchase-receive","id":'$PO',"client_ref":"s1","items":[{"line":0,"qty":4}]}' >/dev/null
cd /tmp
node app-shot2.js $B purchases /downloads/h9-receive-modal.png 1440 900 "openReceive(store.data.purchases[0])" | grep -E "VIEW|MEASURE|SHOT"
node app-shot2.js $B purchases /downloads/h9-purchases-partial.png 1440 800 | grep -E "MEASURE|SHOT"
pkill -f "node server.js"
