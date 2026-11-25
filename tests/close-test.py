# Self-contained closeout checks: real payroll op cash behaviour, legacy POS refund with missing method fields,
# and purchase-return ledger presentation (not revenue, netted against expenses). Fixtures are built by this script:
# real ops, then ONE offline edit of store.json to create the legacy shapes (documented below).
import json, subprocess, time, os, shutil, urllib.request, urllib.error, datetime
def call(B,method,path,body=None,tok=None):
    req=urllib.request.Request(B+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+tok} if tok else {})})
    try:
        r=urllib.request.urlopen(req,timeout=20); return r.status,json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code,json.loads(e.read() or b'{}')
        except Exception: return e.code,{}
PASS=FAIL=0
def ok(n,c,i=''):
    global PASS,FAIL
    if c: PASS+=1
    else: FAIL+=1; print('FAIL:',n,i)
D='/tmp/closed'; B='http://localhost:8712'
shutil.rmtree(D,ignore_errors=True); os.makedirs(D)
def start():
    subprocess.run('pkill -f "node server.js"',shell=True); time.sleep(1)
    return subprocess.Popen(['node','server.js'],cwd='/tmp/nexus-erp',env=dict(os.environ,PORT='8712',DATA_DIR=D),stdout=open('/tmp/close-srv.log','a'),stderr=subprocess.STDOUT)
def login():
    global tok,tx
    tok=call(B,'POST','/api/login',{'username':'admin','password':'admin1234'})[1]['token']; tx=lambda p:call(B,'POST','/api/tx',p,tok)
srv=start(); time.sleep(1.5)
call(B,'POST','/api/setup',{'username':'admin','password':'admin1234','code':open(D+'/setup-code').read().strip()}); login()
call(B,'PUT','/api/data',{'data':{'suppliers':[{'id':777,'name':'S'}],'employees':[{'id':1,'name':'E1','status':'active','salary':300},{'id':2,'name':'E2','status':'active','salary':200}]}},tok=tok)
pid=tx({'op':'product-save','out':{'name':'W','price':30,'cost':10,'stock':100}})[1]['product']['id']
# ---- payroll through the real op
r=tx({'op':'payroll'}); ok('P1 payroll op runs for two active employees, total 500',r[0]==200 and r[1].get('total')==500,r)
ok('P2 second payroll run for the same month is refused',tx({'op':'payroll'})[0]!=200)
# ---- POS sales
sh=tx({'op':'pos-shift-open','opening_float':0})[1]['shift']['id']
def sale(m,n): return tx({'op':'pos-sale','client_ref':n,'shift_id':sh,'method':m,'items':[{'product_id':pid,'qty':1,'price':30}]})[1]['invoice']['id']
s1=sale('cash','a'); s2=sale('bank','b'); s3=sale('bank','c')
# ---- purchases for the presentation checks
rec=lambda q:tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':q,'cost':10}]}})[1]['purchase']['id']
pa=rec(5)   # unpaid: a return reduces the payable only (no cash, no credit)
pb=rec(4); tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':pb,'amount':40,'method':'bank'})  # fully paid: a store-credit return creates supplier credit
r1=tx({'op':'purchase-return-create','purchase_id':pa,'reason':'ap reduction','items':[{'line':0,'qty':2}]}); ok('A0 payable-reducing return posted',r1[0]==200,r1)
r2=tx({'op':'purchase-return-create','purchase_id':pb,'reason':'keep credit','items':[{'line':0,'qty':1}],'store_credit':True}); ok('A0b credit return posted',r2[0]==200,r2)
r3=tx({'op':'purchase-return-create','purchase_id':pb,'reason':'refund back','items':[{'line':0,'qty':1}],'refund_confirmed':True,'refund_method':'bank','refund_reference':'R-1'}); ok('A0c refunded return posted',r3[0]==200,r3)
srv.terminate(); time.sleep(1)
# ---- offline legacy shaping (the only non-real step): old POS data lacked pos_method and payment.method
st=json.load(open(D+'/store.json')); d=st['data']; acc={a['code']:a['id'] for a in d['accounts']}
pays={p['ref_id']:p for p in d['payments'] if p['ref_type']=='invoice' and p['direction']=='in'}
invs={i['id']:i for i in d['invoices']}
for i in (s1,s2,s3): pays[i].pop('method',None)
for i in (s1,s3): invs[i].pop('pos_method',None)        # s1: cash sale, nothing recorded; s3: bank sale, nothing recorded
jr={j['id']:j for j in d['journal']}
for l in jr[pays[s2]['journal_id']]['lines']:           # s2: bank sale booked to the till (legacy), pos_method kept
    if l['account_id']==acc['1010']: l['account_id']=acc['1000']
json.dump(st,open(D+'/store.json','w'))
srv=start(); time.sleep(1.5); login()
def credit_acct(invid):
    d=call(B,'GET','/api/data',tok=tok)[1]['data']
    j=[j for j in d['journal'] if j['ref_type']=='pos-refund' and j['ref_id']==invid]
    return j,d
r=tx({'op':'pos-refund','id':s1}); j,d=credit_acct(s1)
ok('L1 legacy cash sale with no method fields refunds from the till (1000)',r[0]==200 and len(j)==1 and any(l['account_id']==acc['1000'] and l['credit'] for l in j[0]['lines']),r)
ok('L1b the refund payment row records an explicit method',[p['method'] for p in d['payments'] if p['direction']=='out' and p['ref_id']==s1]==['cash'])
r=tx({'op':'pos-refund','id':s2}); ok('L2 bank sale booked to the till (pos_method bank, payment method missing) is blocked, no silent reclass',r[0]!=200 and 'reclass' in json.dumps(r[1]),r)
rc=tx({'op':'reclass-settlement','id':pays[s2]['id']}); ok('L2b admin reclass accepts it even though payment.method is missing (falls back to the sale pos_method)',rc[0]==200 and rc[1].get('posted')==1,rc)
r=tx({'op':'pos-refund','id':s2}); j,d=credit_acct(s2)
ok('L2c after reclass the refund pays out of the bank account (1010)',r[0]==200 and any(l['account_id']==acc['1010'] and l['credit'] for l in j[0]['lines']),r)
r=tx({'op':'pos-refund','id':s3}); j,d=credit_acct(s3)
ok('L3 bank sale with no method anywhere refunds from bank (inferred from the original posting), not from the till',r[0]==200 and any(l['account_id']==acc['1010'] and l['credit'] for l in j[0]['lines']) and not any(l['account_id']==acc['1000'] and l['credit'] for l in j[0]['lines']),r)
ok('L3b refund payment row for it says bank',[p['method'] for p in d['payments'] if p['direction']=='out' and p['ref_id']==s3]==['bank'])
ok('L4 refunds are one-time',tx({'op':'pos-refund','id':s1})[0]!=200)
# ---- payroll cash behaviour from the store
pj=[j for j in d['journal'] if j['ref_type']=='payroll']
ok('P3 payroll posts exactly one journal, Dr 6100 500 / Cr Cash 1000 500 (never the bank)',len(pj)==1 and sorted((l['account_id'],l['debit'] or 0,l['credit'] or 0) for l in pj[0]['lines'])==sorted([(acc['6100'],500,0),(acc['1000'],0,500)]),pj)
pl=[l for l in d['ledger'] if l.get('ref_type')=='payroll']
ok('P4 ledger has one Payroll expense per employee summing to the journal (500)',len(pl)==2 and sum(l['amount'] for l in pl)==500)
# ---- purchase adjustment presentation, using the page code
out=subprocess.run(['node','cash-eval.js',B,'finance','/tmp/y.png','1440','1200','2026-11-01',datetime.date.today().isoformat(),'/tmp/close.xlsx'],cwd='/tmp/ts',capture_output=True,text=True,timeout=60).stdout
rep=json.loads([l for l in out.splitlines() if l.startswith('REPORT:')][0][7:])[0]; tot=json.loads([l for l in out.splitlines() if l.startswith('TOTALS:')][0][7:])
d=call(B,'GET','/api/data',tok=tok)[1]['data']; ld=d['ledger']; mo=datetime.date.today().isoformat()[:7]
adj=lambda l:l.get('ref_type')=='purchase_return' or l['category'] in('Purchase return','Purchase return void','Purchase receipt void')
cur=[l for l in ld if (l['date'] or '').startswith(mo)]
inc=sum(l['amount'] for l in cur if l['type']=='income' and not adj(l)); a=sum(l['amount'] for l in cur if l['type']=='income' and adj(l))-sum(l['amount'] for l in cur if l['type']=='expense' and adj(l))
exp_=sum(l['amount'] for l in cur if l['type']=='expense' and not adj(l))-a
oldnet=sum(l['amount'] for l in cur if l['type']=='income')-sum(l['amount'] for l in cur if l['type']=='expense')
prs=[l for l in cur if l.get('ref_type')=='purchase_return' and l['type']=='income']
print('purchase_return ledger rows:',[(l['amount'],l['memo']) for l in prs],'page totals',tot)
ok('A1 purchase-return rows exist only as adjustments (AP-reduction 20 and refunded 10; credit part none)',sorted(l['amount'] for l in prs)==[10,20],[l['amount'] for l in prs])
ok('A2 page Income excludes purchase adjustments',abs(tot['income']-inc)<0.005,(tot['income'],inc))
ok('A3 page Expenses are net of purchase adjustments',abs(tot['expense']-exp_)<0.005,(tot['expense'],exp_))
ok('A4 net is unchanged by the presentation',abs(tot['net']-oldnet)<0.005 and abs(tot['purchase_adjustment']-a)<0.005,(tot['net'],oldnet,tot['purchase_adjustment'],a))
# void the AP-reduction return: ledger adjustment nets to zero
rid=[p for p in d['purchase_returns'] if p['reason']=='ap reduction'][0]['id']
ok('A6 void of the payable-reducing return works',tx({'op':'purchase-return-void','id':rid,'reason':'voiding test'})[0]==200)
d=call(B,'GET','/api/data',tok=tok)[1]['data']
rows=[l for l in d['ledger'] if l.get('ref_id')==rid and l.get('ref_type')=='purchase_return']
ok('A7 void mirrors exactly what was posted (income 20 then expense 20)',sorted((l['type'],l['amount']) for l in rows)==[('expense',20),('income',20)],rows)
srv.terminate(); subprocess.run('pkill -f "node server.js"',shell=True)
print('close-test: PASS=%d FAIL=%d'%(PASS,FAIL))
