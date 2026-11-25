B=http://localhost:8497; D=/tmp/corrshot; H="Content-Type: application/json"
pkill -f "node server.js"; sleep 1; rm -rf $D; mkdir -p $D/data; cd /tmp/nexus-erp
(setsid nohup env PORT=8497 DATA_DIR=$D/data node server.js > $D/srv.log 2>&1 &); sleep 1.5
SC=$(cat $D/data/setup-code); curl -s -o /dev/null $B/api/setup -X POST -H "$H" -d "{\"username\":\"admin\",\"password\":\"admin1234\",\"code\":\"$SC\"}"
TOK=$(curl -s $B/api/login -H "$H" -d '{"username":"admin","password":"admin1234"}' | jq -r .token); A="Authorization: Bearer $TOK"
tx(){ curl -s $B/api/tx -X POST -H "$A" -H "$H" -d "$1"; }
curl -s -o /dev/null $B/api/data -X PUT -H "$A" -H "$H" -d '{"data":{"suppliers":[{"id":777,"name":"مورد الاختبار"}],"contacts":[{"id":555,"first_name":"عميل","last_name":"تجريبي"}]}}'
PID=$(tx '{"op":"product-save","out":{"name":"Widget","price":30,"cost":10,"stock":20}}' | jq .product.id)
I=$(tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-01","due_date":"2026-12-01","tax_rate":10,"items":[{"product_id":'$PID',"qty":4,"price":30}]}}' | jq .invoice.id)
tx '{"op":"credit-note-create","invoice_id":'$I',"reason":"damaged in transit","items":[{"line":0,"qty":1,"restock":true}]}' >/dev/null
PO=$(tx '{"op":"purchase-save","out":{"status":"received","supplier_id":777,"items":[{"product_id":'$PID',"qty":5,"cost":10}]}}' | jq .purchase.id)
tx '{"op":"purchase-return-create","purchase_id":'$PO',"reason":"defective batch","items":[{"line":0,"qty":2}]}' >/dev/null
O=$(tx '{"op":"order-save","out":{"status":"draft","contact_id":555,"order_date":"2026-11-02","tax_rate":0,"items":[{"product_id":'$PID',"qty":2,"price":30}]}}' | jq .order.id); tx '{"op":"order-confirm","id":'$O'}' >/dev/null; tx '{"op":"order-fulfill","id":'$O'}' >/dev/null
cd /tmp




I2=$(tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-06","due_date":"2026-12-01","tax_rate":0,"items":[{"description":"service","qty":1,"price":100}]}}' | jq .invoice.id)
tx '{"op":"payment","direction":"in","ref_type":"invoice","ref_id":'$I2',"amount":100,"method":"bank"}' >/dev/null
tx '{"op":"credit-note-create","invoice_id":'$I2',"reason":"overpaid","items":[{"line":0,"qty":1}],"store_credit":true}' | jq -c '.credit_note.store_credit'
I3=$(tx '{"op":"invoice-save","out":{"status":"sent","contact_id":555,"issue_date":"2026-11-07","due_date":"2026-12-01","tax_rate":0,"items":[{"description":"service 2","qty":1,"price":60}]}}' | jq .invoice.id)
CCID=$(curl -s $B/api/data -H "$A" | jq '.data.customer_credits[0].id'); echo CC=$CCID; tx '{"op":"credit-apply","credit_id":'$CCID',"invoice_id":'$I3',"amount":25}' | cut -c1-200
PO2=$(tx '{"op":"purchase-save","out":{"status":"ordered","supplier_id":777,"items":[{"product_id":'$PID',"qty":10,"cost":10}]}}' | jq .purchase.id)
tx '{"op":"purchase-receive","id":'$PO2',"items":[{"line":0,"qty":4}]}' | jq -c .complete
cd /tmp
node app-shot2.js $B invoices /downloads/h15-invoices-credit.png 1440 1500 | grep -E "MEASURE|SHOT"
node app-shot2.js $B purchases /downloads/h15-purchases-voidreceipt.png 1440 1300 | grep -E "MEASURE|SHOT"
pkill -f "node server.js"
