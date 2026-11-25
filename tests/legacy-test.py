# Self-contained upgrade test: builds a REAL legacy store with the hotfix8 code (git 0cf5580, what the user got),
# then runs the hotfix16 code on it. Needs: git worktree of 0cf5580 at /tmp/legacy-app, repo at /tmp/nexus-erp.
import json, subprocess, time, os, shutil, hashlib, urllib.request, urllib.error
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
def start(app,port,data):
    subprocess.run('pkill -f "node server.js"',shell=True); time.sleep(1)
    p=subprocess.Popen(['node','server.js'],cwd=app,env=dict(os.environ,PORT=str(port),DATA_DIR=data),stdout=open('/tmp/lg-srv.log','a'),stderr=subprocess.STDOUT); time.sleep(1.5); return p
D='/tmp/lgdata'; shutil.rmtree(D,ignore_errors=True); os.makedirs(D)
# ---- 1. build legacy store with hotfix8 code
B='http://localhost:8601'; srv=start('/tmp/legacy-app',8601,D)
code=open(D+'/setup-code').read().strip()
call(B,'POST','/api/setup',{'username':'boss','password':'b0ss-pass-1','code':code})
tok=call(B,'POST','/api/login',{'username':'boss','password':'b0ss-pass-1'})[1]['token']
tx=lambda p,t=None:call(B,'POST','/api/tx',p,t or tok)
call(B,'PUT','/api/data',{'data':{'suppliers':[{'id':777,'name':'S'},{'id':778,'name':'S2'}],'contacts':[{'id':555,'first_name':'C','last_name':'D'},{'id':556,'first_name':'E','last_name':'F'}]}},tok=tok)
pid=tx({'op':'product-save','out':{'name':'W','price':30,'cost':10,'stock':20}})[1]['product']['id']
i1=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-01','due_date':'2026-12-01','tax_rate':10,'items':[{'product_id':pid,'qty':4,'price':30}]}})[1]['invoice']['id']
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':i1,'amount':50,'method':'bank'})
i2=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-02','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'svc','qty':1,'price':100}]}})[1]['invoice']['id']
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':i2,'amount':100,'method':'cash'})
po1=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':5,'cost':10}]}})[1]['purchase']['id']
tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':po1,'amount':50,'method':'bank'})
po2=tx({'op':'purchase-save','out':{'status':'received','supplier_id':778,'items':[{'product_id':pid,'qty':2,'cost':10}]}})[1]['purchase']['id']
r=tx({'op':'credit-note-create','invoice_id':i1,'reason':'damaged','items':[{'line':0,'qty':1}]}); ok('L0 legacy build ok',r[0]==200,r)
legacy=json.load(open(D+'/store.json'))
srv.terminate(); time.sleep(1)
ok('L1 legacy store has no 1150/2150 accounts and no credit collections',not any(a['code'] in('1150','2150') for a in legacy['data']['accounts']) and 'supplier_credits' not in legacy['data'] and 'customer_credits' not in legacy['data'])
shutil.copy(D+'/store.json','/tmp/lg-legacy-store.json')
h0=hashlib.sha256(open(D+'/store.json','rb').read()).hexdigest()
# ---- 2. start new code on it
B='http://localhost:8602'; srv=start('/tmp/nexus-erp',8602,D)
ok('L2 startup leaves legacy store.json byte-identical',hashlib.sha256(open(D+'/store.json','rb').read()).hexdigest()==h0)
tok=call(B,'POST','/api/login',{'username':'boss','password':'b0ss-pass-1'})[1]['token']
tx=lambda p,t=None:call(B,'POST','/api/tx',p,t or tok)
Dd=lambda:call(B,'GET','/api/data',tok=tok)[1]['data']
def acct(code,d=None):
    d=d or Dd(); a=[x for x in d['accounts'] if x['code']==code]
    if not a: return 0.0
    return round(sum((l.get('debit') or 0)-(l.get('credit') or 0) for j in d['journal'] for l in j['lines'] if l['account_id']==a[0]['id']),2)
d=Dd(); old_journal=json.dumps(d['journal'],sort_keys=True)
# store credit on legacy over-paid invoice i2 (paid 100)
r=tx({'op':'credit-note-create','invoice_id':i2,'reason':'overpaid','items':[{'line':0,'qty':1}],'store_credit':True}); ok('L3 customer credit on legacy invoice',r[0]==200 and r[1]['credit_note']['store_credit']==100,r)
# supplier credit on legacy purchase po1 (paid 50)
r=tx({'op':'purchase-return-create','purchase_id':po1,'reason':'defective','items':[{'line':0,'qty':5}],'store_credit':True}); ok('L4 supplier credit on legacy purchase',r[0]==200 and r[1]['purchase_return']['store_credit']==50,r)
d=Dd()
ok('L5 legacy journal entries unchanged (prefix identical), 1150=50, 2150=-100',json.dumps(d['journal'][:len(json.loads(old_journal))],sort_keys=True)==old_journal and acct('1150',d)==50 and acct('2150',d)==-100,(acct('1150',d),acct('2150',d)))
ccid=d['customer_credits'][0]['id']; scid=d['supplier_credits'][0]['id']
ix=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-07','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'n','qty':1,'price':70}]}})[1]['invoice']['id']
ok('L6 apply customer credit 40',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':ix,'amount':40})[0]==200)
po3=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':3,'cost':10}]}})[1]['purchase']['id']
ok('L7a wrong supplier (legacy po2 belongs to S2) refused',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':po2,'amount':20})[0]==400)
ok('L7 apply supplier credit 20 to same-supplier purchase',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':po3,'amount':20})[0]==200)
snap=lambda:json.dumps([Dd()['customer_credits'],Dd()['supplier_credits']],sort_keys=True)
before=snap()
# ---- 3. forgery paths: bulk PUT, import-style full document PUT
dd=Dd()
f=json.loads(json.dumps(dd))
for c in f['customer_credits']+f['supplier_credits']:
    c['remaining']=99999; c['amount']=99999; c['applications']=[]; c['status']='open'
f['customer_credits'].append({'id':9001,'contact_id':555,'number':'CC-FAKE','amount':500,'remaining':500,'status':'open','applications':[]})
f['supplier_credits'].append({'id':9002,'supplier_id':777,'number':'SC-FAKE','amount':500,'remaining':500,'status':'open','applications':[]})
rs=call(B,'PUT','/api/data',{'data':f},tok=tok)
ok('L8 full-document PUT (import path) cannot change any credit balance, usage history or add credits',snap()==before,rs)
call(B,'PUT','/api/data',{'data':{'customer_credits':[],'supplier_credits':[]}},tok=tok)
ok('L9 PUT emptying the credit collections is ignored',snap()==before)
# a limited user with module access also cannot
call(B,'POST','/api/users',{'username':'pu','password':'pu-pass-12','role':'employee','modules':['purchases','invoices']},tok=tok)
ptok=call(B,'POST','/api/login',{'username':'pu','password':'pu-pass-12'})[1]['token']
call(B,'PUT','/api/data',{'data':{'customer_credits':f['customer_credits'],'supplier_credits':f['supplier_credits']}},tok=ptok)
ok('L10 non-admin module user PUT cannot forge either',snap()==before)
ok('L11 non-admin cannot apply supplier credit',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':po3,'amount':1},ptok)[0] in (400,403))
# ---- 4. restart: credits and history survive, books reconcile
srv.terminate(); time.sleep(1)
srv=start('/tmp/nexus-erp',8602,D)
tok=call(B,'POST','/api/login',{'username':'boss','password':'b0ss-pass-1'})[1]['token']
ok('L12 credits survive restart unchanged (balances, applications)',snap()==before)
d=Dd(); cc=d['customer_credits'][0]; sc=d['supplier_credits'][0]
ok('L13 remaining 60 / 30 and GL 2150=-60, 1150=30',cc['remaining']==60 and sc['remaining']==30 and acct('2150',d)==-60 and acct('1150',d)==30,(cc['remaining'],sc['remaining']))
# ---- 5. offline tamper (edited store.json): integrity gate stops the next posting
srv.terminate(); time.sleep(1)
st=json.load(open(D+'/store.json')); st['data']['supplier_credits'][0]['remaining']=9999
json.dump(st,open(D+'/store.json','w'))
srv=start('/tmp/nexus-erp',8602,D)
tok=call(B,'POST','/api/login',{'username':'boss','password':'b0ss-pass-1'})[1]['token']
r=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-08','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'z','qty':1,'price':5}]}})
ok('L14 tampered credit balance (offline edit) is caught: posting refused as unreconciled',r[0]!=200 and 'credit' in json.dumps(r[1]).lower(),r)
srv.terminate(); subprocess.run('pkill -f "node server.js"',shell=True)
# ---- 6. full backup/restore round trip keeps credit history (restore = file copy while stopped)
print('legacy-test: PASS=%d FAIL=%d'%(PASS,FAIL))
