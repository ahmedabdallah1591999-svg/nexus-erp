#!/bin/bash
# End-to-end install/backup/restore/auth test for the deploy package.
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (want [$3] got [$2])"; fi; }
B=http://localhost:8494
T=/tmp/pkgtest-target

pkill -f "node server.js" 2>/dev/null; sleep 1
rm -rf "$T"

# 1. install from the repo into a fresh target
OUT=$(bash /tmp/nexus-erp/deploy/install.sh "$T")
ok "P1 install completes" "$?" "0"
ok "P2 app files present" "$(ls "$T"/server.js "$T"/index.html "$T"/backup.sh "$T"/restore.sh 2>/dev/null | wc -l)" "4"
ok "P3 data dir empty (no seeded data)" "$(ls "$T"/data | wc -l)" "0"

# 2. start, setup admin, login, create data
cd "$T"
setsid nohup env PORT=8494 node server.js > "$T/srv.log" 2>&1 &
sleep 1.5
SCODE=$(cat "$T/data/setup-code")
ok "P4 setup creates admin" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/setup -X POST -H 'Content-Type: application/json' -d "{\"username\":\"owner\",\"password\":\"s3cret-pass\",\"code\":\"$SCODE\"}")" "200"
TOK=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"owner","password":"s3cret-pass"}' | jq -r .token)
AUTH="Authorization: Bearer $TOK"
ok "P5 login works" "$([ -n "$TOK" ] && [ "$TOK" != null ] && echo yes)" "yes"
ok "P6 wrong password rejected" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/login -H 'Content-Type: application/json' -d '{"username":"owner","password":"wrong"}')" "401"
curl -s $B/api/tx -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"op":"product-save","out":{"name":"Package Widget","price":30,"cost":12,"stock":20}}' > /dev/null
ok "P7 data created" "$(curl -s $B/api/data -H "$AUTH" | jq '.data.products | length')" "1"

# 2b. network-binding security: default bind must be loopback-only,
#     and setup must refuse non-loopback callers even in LAN mode
LANIP=$(hostname -I 2>/dev/null | awk '{print $1}')
ok "P14 default bind refuses LAN address" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://$LANIP:8494/api/ping 2>/dev/null)" "000"
rm -rf "$T/data-lan"
env PORT=8495 HOST=0.0.0.0 DATA_DIR="$T/data-lan" node "$T/server.js" > "$T/srv-lan.log" 2>&1 &
LANPID=$!
node -e "require('net').createServer(s=>{const c=require('net').connect(8495,'127.0.0.1');s.pipe(c).pipe(s)}).listen(8497,'127.0.0.1')" &
PROXYPID=$!
sleep 1.5
LANCODE=$(cat "$T/data-lan/setup-code")
ok "P15 LAN caller without setup code rejected" "$(curl -s -o /dev/null -w '%{http_code}' http://$LANIP:8495/api/setup -X POST -H 'Content-Type: application/json' -d '{"username":"intruder","password":"h4ck-pass"}')" "401"
ok "P16 wrong setup code rejected" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8495/api/setup -X POST -H 'Content-Type: application/json' -d '{"username":"intruder","password":"h4ck-pass","code":"DEADBEEF00"}')" "401"
ok "P17 proxy path + spoofed headers cannot claim setup" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8497/api/setup -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Real-IP: 203.0.113.9' -d '{"username":"intruder","password":"h4ck-pass"}')" "401"
ok "P18 security headers present" "$(curl -sD - -o /dev/null $B/api/ping | grep -ci 'x-content-type-options: nosniff')" "1"
ok "P19 correct setup code still works" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8495/api/setup -X POST -H 'Content-Type: application/json' -d "{\"username\":\"lanadmin\",\"password\":\"l4n-pass\",\"code\":\"$LANCODE\"}")" "200"
kill $LANPID $PROXYPID 2>/dev/null; wait $LANPID 2>/dev/null; wait $PROXYPID 2>/dev/null; sleep 1
rm -rf "$T/data-lan"

# 3. backup
OUT=$(bash "$T/backup.sh")
ok "P8 backup created" "$(ls "$T"/backups | wc -l)" "1"

# 4. disaster: stop server, wipe data
pkill -f "node server.js"; sleep 1
rm -rf "$T/data"
ok "P9 data wiped" "$(ls "$T"/data 2>/dev/null | wc -l)" "0"

# 5. restore, restart
bash "$T/restore.sh" > /dev/null
ok "P10 restore returns store.json" "$(ls "$T"/data/store.json 2>/dev/null | wc -l)" "1"
cd "$T" && setsid nohup env PORT=8494 node server.js > "$T/srv2.log" 2>&1 &
sleep 1.5
TOK2=$(curl -s $B/api/login -H 'Content-Type: application/json' -d '{"username":"owner","password":"s3cret-pass"}' | jq -r .token)
ok "P11 auth survives restore (same password)" "$([ -n "$TOK2" ] && [ "$TOK2" != null ] && echo yes)" "yes"
ok "P12 data survives restore" "$(curl -s $B/api/data -H "Authorization: Bearer $TOK2" | jq -r '.data.products[0].name')" "Package Widget"
ok "P13 stock intact" "$(curl -s $B/api/data -H "Authorization: Bearer $TOK2" | jq '.data.products[0].stock')" "20"

# 6. visual proof: products view after restore (restored credentials)
sed "s/admin1234/s3cret-pass/; s/username: 'admin'/username: 'owner'/" /tmp/app-shot.js > /tmp/app-shot-owner.js
node /tmp/app-shot-owner.js $B products /downloads/pkg-restored.png 1440 900 2>&1 | grep -E 'AUTH|MEASURE|SHOT'

pkill -f "node server.js"
echo "== pkg-test: $PASS passed, $FAIL failed =="
