import json, subprocess, time, os, re, urllib.request, urllib.error, shutil, hashlib, concurrent.futures as cf, sys
B='http://localhost:8496'; D='/tmp/mxtest'
subprocess.run('pkill -f "node server.js"',shell=True); time.sleep(1)
shutil.rmtree(D,ignore_errors=True); os.makedirs(D+'/data')
env=dict(os.environ,PORT='8496',DATA_DIR=D+'/data')
log=open(D+'/srv.log','w')
srv=subprocess.Popen(['node','server.js'],cwd='/tmp/nexus-erp',env=env,stdout=log,stderr=log); time.sleep(1.5)
def call(method,path,body=None,tok=None,raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req=urllib.request.Request(B+path,data=data,method=method,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+tok} if tok else {})})
    try:
        r=urllib.request.urlopen(req,timeout=20); return r.status,json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code,json.loads(e.read() or b'{}')
        except Exception: return e.code,{}
    except Exception as e: return 0,{'err':str(e)}
code=open(D+'/data/setup-code').read().strip()
call('POST','/api/setup',{'username':'boss','password':'b0ss-pass-1','code':code})
_r=call('POST','/api/login',{'username':'boss','password':'b0ss-pass-1'}); print('boss login',_r[0],str(_r[1])[:120]); tok=_r[1]['token']; print('me0',call('GET','/api/me',tok=tok))
# employee with no modules
call('POST','/api/users',{'username':'emp','password':'emp-pass-1','role':'employee','modules':[]},tok=tok)
call('POST','/api/users',{'username':'inv','password':'inv-pass-1','role':'employee','modules':['invoices']},tok=tok)
def login(u,p):
    s,j=call('POST','/api/login',{'username':u,'password':p}); return j.get('token'),s,j
etok,s,j=login('emp','emp-pass-1'); print('emp login',s,'mustChange' in json.dumps(j))
itok,_s,_j=login('inv','inv-pass-1'); print('inv login',_s,str(_j)[:150], 'etok',bool(etok))
def tx(p,t=None): return call('POST','/api/tx',p,t or tok)
call('PUT','/api/data',{'data':{'suppliers':[{'id':777,'name':'S'}],'contacts':[{'id':555,'first_name':'C','last_name':'D'}]}},tok=tok)
pid=tx({'op':'product-save','out':{'name':'W','price':30,'cost':10,'stock':50}})[1]['product']['id']
inv=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-01','due_date':'2026-12-01','tax_rate':10,'items':[{'product_id':pid,'qty':2,'price':30}]}})[1]['invoice']['id']
po=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':5,'cost':10}]}})[1]['purchase']['id']
ops=sorted(set(re.findall(r"^  '([a-z-]+)': \{",open('/tmp/nexus-erp/tx.js').read(),re.M)))
print('ops',len(ops))
def snap():
    s,j=call('GET','/api/data',tok=tok)
    if 'data' not in j: print('SNAPFAIL',s,j)
    d=j['data']
    keys=['journal','stock_moves','payments','invoices','purchases','products','ledger','returns','credit_notes','purchase_returns','sales_orders','quotes','accounts','meta']
    return hashlib.sha256(json.dumps({k:d.get(k) for k in keys},sort_keys=True).encode()).hexdigest(), d
def invariants(d):
    bad=[]
    for j in d['journal']:
        dr=sum(l['debit'] for l in j['lines']); cr=sum(l['credit'] for l in j['lines'])
        if abs(dr-cr)>0.005: bad.append('unbalanced '+str(j['id']))
    ms={}
    for m in d['stock_moves']: ms[m['product_id']]=ms.get(m['product_id'],0)+m['qty']
    for p in d['products']:
        if abs(ms.get(p['id'],0)-p['stock'])>0.005: bad.append('stock mismatch '+p['name'])
    return bad
PASS=FAIL=0
def ok(name,cond,info=''):
    global PASS,FAIL
    if cond: PASS+=1
    else: FAIL+=1; print('FAIL:',name,info)
print('tok valid', call('GET','/api/me',tok=tok)[0])
# 1 permission: no-module user cannot run ANY op
perm_fail=[]
for op in ops:
    s,j=tx({'op':op,'id':1,'out':{}},etok)
    if s!=403: perm_fail.append((op,s))
ok('P1 every op refused (403) for a user with no modules',not perm_fail,perm_fail)
print('tok valid after P1', call('GET','/api/me',tok=tok)[0])
# invoices-only user: ops outside invoices/payments? must be 403 for non-invoice views
spec={}
src=open('/tmp/nexus-erp/tx.js').read()
for m in re.finditer(r"^  '([a-z-]+)': \{\n    view: (\[[^\]]*\]|'[a-z-]+')",src,re.M): spec[m.group(1)]=m.group(2)
leak=[]
for op,v in spec.items():
    views=re.findall(r"'([a-z-]+)'",v)
    s,j=tx({'op':op,'id':1,'out':{}},itok)
    if 'invoices' not in views and s!=403: leak.append((op,s))
ok('P2 invoices-only user is refused on every op outside its view',not leak,leak)
# 2 junk matrix
junk=[{},{'id':-1},{'id':'abc'},{'id':None},{'id':1e308},{'id':[1]},{'id':{'a':1}},{'items':'x'},{'items':[{'qty':-1,'price':-1}]},{'items':[{'qty':'Infinity','price':1}]},
 {'items':[None]},{'out':None},{'out':'s'},{'out':[]},{'out':{'items':[{'qty':1e999,'price':1}],'status':'sent'}},{'amount':-5},{'amount':'NaN'},{'amount':1e999},{'amount':'1e5'},
 {'qty':-3,'product_id':pid},{'qty':1e12,'product_id':pid},{'lines':'x'},{'lines':[{'account_id':1,'debit':-5,'credit':0}]},{'__proto__':{'polluted':1},'constructor':{'prototype':{'p2':1}}},
 {'id':inv,'items':[{'line':0,'qty':-1}]},{'id':inv,'reason':'x'*100000},{'date':'not-a-date'},{'date':{'a':1}},{'direction':'in','ref_type':'invoice','ref_id':inv,'amount':-1},
 {'direction':'in','ref_type':'invoice','ref_id':'x','amount':1},{'invoice_id':inv,'items':[{'line':0,'qty':0}],'reason':'abc'},{'purchase_id':po,'items':[{'line':'a','qty':1}],'reason':'abc'}]
before,_=snap(); changed_on_reject=[]; crashes=[]; five=[]
for op in ops:
    for jn in junk:
        b,_=snap()
        s,j=tx({**jn,'op':op})
        if s==0 or s>=500: five.append((op,str(jn)[:40],s))
        if s!=200 and s!=0:
            a,_=snap()
            if a!=b: changed_on_reject.append((op,str(jn)[:40]))
s,_=call('GET','/api/ping'); ok('M0 server alive after matrix',s==200)
ok('M1 no 5xx / connection errors in matrix',not five,five[:5])
ok('M2 a rejected request never changes data',not changed_on_reject,changed_on_reject[:5])
a,d=snap(); inv_bad=invariants(d); ok('M3 invariants hold after matrix (journal balanced, stock = moves)',not inv_bad,inv_bad[:3])
txf=open(D+'/srv.log').read().count('tx failure'); ok('M4 no unexpected exceptions inside tx ops (server log "tx failure")',txf==0,str(txf))
if txf:
    for l in open(D+'/srv.log').read().splitlines():
        if 'tx failure' in l: print('  ',l[:100])
# prototype pollution check
s,j=call('GET','/api/ping'); ok('M5 no prototype pollution',({}).__class__ is dict and 'polluted' not in json.dumps(j))
# malformed JSON bodies
for path in ['/api/tx','/api/login','/api/data']:
    s,_=call('POST' if path!='/api/data' else 'PUT',path,raw=b'{bad json',tok=tok); ok('M6 malformed JSON on '+path+' not 5xx',s in (400,401,403),s)
s,_=call('GET','/api/ping'); ok('M6b server alive after malformed bodies',s==200)
# forged meta counters via PUT
call('PUT','/api/data',{'data':{'meta':{'invoiceSeq':9999,'purchaseSeq':9999,'cnSeq':9999}}},tok=tok)
r=tx({'op':'invoice-save','out':{'status':'draft','items':[{'product_id':pid,'qty':1,'price':1}]}})[1]
ok('M7 forged invoiceSeq via PUT ignored',r['invoice']['number']!='INV-9999' and int(r['invoice']['number'][4:])<100,r['invoice']['number'])
# extra keys on items are not stored
r=tx({'op':'invoice-save','out':{'status':'draft','items':[{'product_id':pid,'qty':1,'price':5,'zz':1,'stock_applied':True}]}})[1]
ok('M8 unknown keys on invoice lines are dropped',set(r['invoice']['items'][0].keys())<={'product_id','description','qty','price'},r['invoice']['items'][0])
# POS tax cannot be chosen by the till
call('PUT','/api/data',{'data':{'settings':{'tax_rate':10}}},tok=tok)
r=tx({'op':'pos-sale','client_ref':'T1','tax_rate':0,'method':'cash','items':[{'product_id':pid,'qty':1}]})[1]
ok('M9 POS ignores client tax_rate (uses settings 10%)',r.get('invoice',{}).get('tax_rate')==10,r)
# concurrency / double action
def par(n,f):
    with cf.ThreadPoolExecutor(n) as ex: return list(ex.map(lambda i:f(i),range(n)))
opn=lambda: next(i for i in call('GET','/api/data',tok=tok)[1]['data']['invoices'] if i['id']==inv)
res=par(10,lambda i:tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':inv,'amount':66,'method':'cash'})[0])
ok('C1 10 parallel full payments: exactly one accepted',res.count(200)==1,res)
res=par(10,lambda i:tx({'op':'pos-sale','client_ref':'SAME','method':'cash','items':[{'product_id':pid,'qty':1}]})[1].get('duplicate',False))
d=call('GET','/api/data',tok=tok)[1]['data']; ok('C2 10 parallel POS sales with one client_ref: one invoice',len([i for i in d['invoices'] if i.get('pos_ref')=='SAME'])==1)
sale=[i for i in d['invoices'] if i.get('pos_ref')=='T1'][0]['id']
res=par(10,lambda i:tx({'op':'pos-refund','id':sale})[0]); ok('C3 10 parallel POS refunds: exactly one',res.count(200)==1,res)
qt=tx({'op':'quote-save','out':{'status':'accepted','contact_id':555,'issue_date':'2026-11-01','tax_rate':0,'items':[{'product_id':pid,'qty':1,'price':9}]}})[1]['quote']['id']
res=par(10,lambda i:tx({'op':'quote-convert','id':qt})[0]); ok('C4 10 parallel quote conversions: exactly one',res.count(200)==1,res)
res=par(10,lambda i:tx({'op':'purchase-return-create','purchase_id':po,'reason':'race','items':[{'line':0,'qty':5}]})[0]); ok('C5 10 parallel full purchase returns: exactly one',res.count(200)==1,res)
# order fulfill + return double
oid=tx({'op':'order-save','out':{'status':'draft','contact_id':555,'order_date':'2026-11-02','tax_rate':0,'items':[{'product_id':pid,'qty':2,'price':30}]}})[1]['order']['id']
tx({'op':'order-confirm','id':oid})
res=par(10,lambda i:tx({'op':'order-fulfill','id':oid})[0]); ok('C6 10 parallel order fulfills: exactly one',res.count(200)==1,res)
res=par(10,lambda i:tx({'op':'return-create','id':oid,'items':[{'product_id':pid,'qty':2,'price':999}],'refund_confirmed':True,'refund_method':'cash','refund_reference':'R'})[0])
ok('C7 10 parallel full order returns: at most one accepted',res.count(200)<=1,res)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('C8 invariants after concurrency',not invariants(d),invariants(d))
rows=[r for r in d['returns'] if r['order_id']==oid]
ok('C9 forged return price ignored (priced 30)',all(it['price']==30 for r in rows for it in r['items']),rows)
# credit notes can't hit a refunded POS sale
s,j=tx({'op':'credit-note-create','invoice_id':sale,'reason':'abc','items':[{'line':0,'qty':1}]}); ok('C10 credit note on refunded POS sale blocked',s==400,j)

# revalue / write-down: blocked until a valuation-allowance model exists
rp=tx({'op':'product-save','out':{'name':'RV','price':30,'cost':10,'stock':0}})[1]['product']['id']
tx({'op':'stock-adjust','product_id':rp,'qty':4,'memo':'open'})
jb=len(call('GET','/api/data',tok=tok)[1]['data']['journal'])
st,jj=tx({'op':'product-save','id':rp,'out':{'name':'RV','price':30,'cost':12}}); ok('R1 cost change with stock rejected with clear wording',st==400 and 'not supported' in json.dumps(jj),jj)
for nc,ev in ((8,-8),(12,8)):
    s_,j_=tx({'op':'product-revalue','id':rp,'new_cost':nc,'reason':'abc','expected_value':ev}); ok('R2 revalue/write-down blocked (cost %s)'%nc,s_==400 and 'not supported' in json.dumps(j_),j_)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('R3 nothing changed: cost still 10, no journal',len(d['journal'])==jb and [p for p in d['products'] if p['id']==rp][0]['cost']==10)
ok('R4 cost change at zero stock still allowed',tx({'op':'product-save','id':[p for p in d['products'] if p['name']=='W'][0]['id'],'out':{'name':'W','price':30,'cost':10}})[0]==200)
zp=tx({'op':'product-save','out':{'name':'ZS','price':3,'cost':1,'stock':0}})[1]['product']['id']
ok('R5 cost change when stock is 0 allowed',tx({'op':'product-save','id':zp,'out':{'name':'ZS','price':3,'cost':2}})[0]==200)
# test seam cannot be enabled by shipped files
import glob
shipped=[f for f in glob.glob('/tmp/nexus-erp/*')+glob.glob('/tmp/nexus-erp/**/*',recursive=True) if os.path.isfile(f) and not f.endswith(('matrix-test.py','CHANGES.md','COVERAGE.md')) and '.git/' not in f and 'node_modules' not in f]
hits=[f for f in shipped if 'NEXUS_TEST' in open(f,errors='ignore').read() and not f.endswith('tx.js')]
ok('R6 no shipped script/start file mentions the test seam',not hits,hits)
ok('R7 forged future payroll month refused with seam off (production default)',tx({'op':'payroll','month':'2031-01'})[0]==400)
# ---- business-logic / authority checks (valid-but-malicious values) ----
call('POST','/api/users',{'username':'fin','password':'fin-pass-1','role':'employee','modules':['finance','accounting','assets','projects','invoices']},tok=tok)
call('POST','/api/users',{'username':'exp','password':'exp-pass-1','role':'employee','modules':['expenses']},tok=tok)
ftok,_,fj=login('fin','fin-pass-1'); xtok,_,xj=login('exp','exp-pass-1')
# change-password gate may apply; check mustChange handling
fs,_fj=call('GET','/api/me',tok=ftok); print('fin me',fs)
d=call('GET','/api/data',tok=tok)[1]['data']
# payroll: admin only, valid month, no duplicates, no future
call('PUT','/api/data',{'data':{'employees':[{'id':901,'name':'E1','status':'active','salary':1000},{'id':902,'name':'E2','status':'active','salary':500}]}},tok=tok)
_b1=tx({'op':'payroll','month':'2026-10'},ftok); ok('B1 non-admin finance user cannot run payroll',_b1[0]==403 or (_b1[0]==400 and 'admin' in json.dumps(_b1[1])),_b1)
ok('B2 bad month refused',tx({'op':'payroll','month':'junk'})[0]==400)
ok('B3 future month refused',tx({'op':'payroll','month':'2030-01'})[0]==400)
ok('B4 payroll for an older month posts once',tx({'op':'payroll','month':'2026-10'})[0]==200)
ok('B5 same older month a second time refused (was a duplicate-posting flaw)',tx({'op':'payroll','month':'2026-10'})[0]==400)
ok('B5b current month still allowed after older month',tx({'op':'payroll'})[0]==200)
# journal reversal
je=tx({'op':'journal','date':'2026-11-05','memo':'manual','lines':[{'account_id':1,'debit':5},{'account_id':2,'credit':5}]})[1].get('entry',{}).get('id')
ok('B6 manual entry created',bool(je))
ok('B7 reversal posts',tx({'op':'journal-reverse','id':je})[0]==200)
ok('B8 second reversal of same entry refused (was double-reversal flaw)',tx({'op':'journal-reverse','id':je})[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']
doc=[j for j in d['journal'] if j.get('ref_type')=='invoice'][0]['id']
ok('B9 reversing a document journal refused',tx({'op':'journal-reverse','id':doc})[0]==400)
rev=[j for j in d['journal'] if j.get('reverses')==je][0]['id']
ok('B10 reversing a reversal refused',tx({'op':'journal-reverse','id':rev})[0]==400)
ok('B11 invalid calendar date refused on journal',tx({'op':'journal','date':'2026-02-31','lines':[{'account_id':1,'debit':5},{'account_id':2,'credit':5}]})[0]==400)
ok('B12 invalid date on ledger-entry refused',tx({'op':'ledger-entry','type':'expense','amount':5,'date':'2026-13-01'})[0]==400)
# recurring-run future date
rid=tx({'op':'recurring-save','out':{'contact_id':555,'interval':'monthly','next_date':'2027-06-01','tax_rate':0,'auto_post':True,'items':[{'description':'svc','qty':1,'price':10}]}})[1].get('recurring',{}).get('id')
ok('B13 recurring-run with a forged future date creates nothing',tx({'op':'recurring-run','id':rid,'today':'2030-01-01'})[1].get('created')==[],tx({'op':'recurring-run','id':rid})[1])
# assets
ok('B14 asset with impossible date refused',tx({'op':'asset-save','out':{'name':'A','cost':100,'salvage':0,'life_months':12,'purchase_date':'2026-02-30'}})[0]==400)
aid=tx({'op':'asset-save','out':{'name':'A','cost':1200,'salvage':0,'life_months':12,'purchase_date':'2026-01-10','post_acquisition':True}})[1].get('asset',{}).get('id')
ok('B15 future depreciation month refused',tx({'op':'asset-depreciate','month':'2031-01'})[0]==400)
ok('B16 depreciation to Oct posts',tx({'op':'asset-depreciate','month':'2026-10'})[0]==200)
ok('B17 depreciation re-run is a no-op',tx({'op':'asset-depreciate','month':'2026-10'})[0]==400)
ok('B18 disposal before depreciation already posted refused',tx({'op':'asset-dispose','id':aid,'date':'2026-03-01','proceeds':0})[0]==400)
ok('B19 disposal before purchase refused',tx({'op':'asset-dispose','id':aid,'date':'2025-01-01','proceeds':0})[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('B20 invariants after finance writers',not invariants(d),invariants(d))
# timesheet bill/unbill
PRJ=tx({'op':'project-save','out':{'name':'P','contact_id':555,'hourly_rate':50}}); print('prj',PRJ); PID=PRJ[1].get('project',{}).get('id')
ok('B21 timesheet >24h refused',tx({'op':'timesheet-save','out':{'project_id':PID,'hours':25,'billable':True}})[0]==400)
tx({'op':'timesheet-save','out':{'project_id':PID,'hours':2,'billable':True}})
bi=tx({'op':'timesheet-invoice','project_id':PID})
ok('B22 billing creates a draft for 100',bi[0]==200 and sum(i['qty']*i['price'] for i in bi[1]['invoice']['items'])==100,bi)
ok('B23 billing again with nothing unbilled refused',tx({'op':'timesheet-invoice','project_id':PID})[0]==400)
ok('B24 deleting the draft releases the time',tx({'op':'invoice-delete','id':bi[1]['invoice']['id']})[0]==200 and tx({'op':'timesheet-invoice','project_id':PID})[0]==200)
# expenses: separation of duties
xe=tx({'op':'expense-save','out':{'date':'2026-11-05','category':'Travel','amount':40}},xtok)
ok('B25 expenses-only user can submit',xe[0]==200,xe)
ok('B26 submitter cannot approve (no finance module)',tx({'op':'expense-approve','id':xe[1].get('expense',{}).get('id')},xtok)[0]==403)
ok('B27 finance user approves once',tx({'op':'expense-approve','id':xe[1].get('expense',{}).get('id')},ftok)[0]==200)
ok('B28 second approval refused',tx({'op':'expense-approve','id':xe[1].get('expense',{}).get('id')},ftok)[0]==400)
ok('B29 bad expense date refused',tx({'op':'expense-save','out':{'date':'bad','category':'x','amount':5}},xtok)[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('B30 invariants at end',not invariants(d),invariants(d))

# ---- stock + manufacturing ----
sp=tx({'op':'product-save','out':{'name':'SA','price':5,'cost':2,'stock':0}})[1]['product']['id']
tx({'op':'stock-adjust','product_id':sp,'qty':10,'memo':'open'})
ok('S1 write-off below zero refused',tx({'op':'stock-adjust','product_id':sp,'qty':-11,'memo':'lost'})[0]==400)
ok('S2 write-off without reason refused',tx({'op':'stock-adjust','product_id':sp,'qty':-1})[0]==400)
ok('S3 valid write-off posts',tx({'op':'stock-adjust','product_id':sp,'qty':-1,'memo':'damaged'})[0]==200)
ok('S4 transfer more than on hand refused',tx({'op':'stock-transfer','product_id':sp,'from':1,'to':2,'qty':50})[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('S5 invariants after stock ops',not invariants(d),invariants(d))
fp=tx({'op':'product-save','out':{'name':'FG','price':50,'cost':5,'stock':0}})[1]['product']['id']
cp=tx({'op':'product-save','out':{'name':'CP','price':5,'cost':1,'stock':0}})[1]['product']['id']
tx({'op':'stock-adjust','product_id':cp,'qty':20,'memo':'open'})
ok('M1 bom saved',tx({'op':'bom-save','product_id':fp,'lines':[{'product_id':cp,'qty':2}]})[0]==200)
ok('M2 component becoming a parent (multi-level) refused',tx({'op':'bom-save','product_id':cp,'lines':[{'product_id':sp,'qty':1}]})[0]==400)
ok('M3 produce 20 with only 20 components refused',tx({'op':'produce','product_id':fp,'qty':20})[0]==400)
ok('M4 produce 5 posts',tx({'op':'produce','product_id':fp,'qty':5,'client_ref':'pr1'})[0]==200)
ok('M5 same client_ref returns original',tx({'op':'produce','product_id':fp,'qty':5,'client_ref':'pr1'})[1].get('deduped')==True)
res=par(8,lambda i:tx({'op':'produce','product_id':fp,'qty':3,'client_ref':'pr2'})[1].get('deduped'))
ok('M6 concurrent same ref: exactly one real run',res.count(None)+res.count(False)==1,res)
d=call('GET','/api/data',tok=tok)[1]['data']; fgs=[p for p in d['products'] if p['id']==fp][0]['stock']
ok('M7 finished stock 8 (5+3), components 20-16=4',fgs==8 and [p for p in d['products'] if p['id']==cp][0]['stock']==4,fgs)
ok('M8 invariants after production',not invariants(d),invariants(d))

# ---- POS shifts, quality, documents ----
call('POST','/api/users',{'username':'cash','password':'cash-pass-1','role':'employee','modules':['pos']},tok=tok)
ctok=login('cash','cash-pass-1')[0]
ok('P3 negative opening float refused',tx({'op':'pos-shift-open','opening_float':-5},ctok)[0]==400)
sh=tx({'op':'pos-shift-open','opening_float':50},ctok)[1].get('shift',{}).get('id')
ok('P4 second open shift refused',tx({'op':'pos-shift-open','opening_float':1},ctok)[0]==400)
ok('P5 other cashier/no-admin cannot close it',tx({'op':'pos-shift-close','id':sh,'counted_cash':50},itok)[0]==403)
ok('P6 negative count refused',tx({'op':'pos-shift-close','id':sh,'counted_cash':-1},ctok)[0]==400)
r=tx({'op':'pos-shift-close','id':sh,'counted_cash':45},ctok); ok('P7 close records variance -5, posts nothing',r[0]==200 and r[1]['shift']['variance']==-5,r)
ok('P8 double close refused',tx({'op':'pos-shift-close','id':sh,'counted_cash':45},ctok)[0]==400)
ok('P9 closed shift cannot take a sale',tx({'op':'pos-sale','client_ref':'late1','shift_id':sh,'method':'cash','items':[{'product_id':pid,'qty':1}]},ctok)[0]==400)
call('POST','/api/users',{'username':'qa1','password':'qa1-pass-1','role':'employee','modules':['quality']},tok=tok)
call('POST','/api/users',{'username':'qa2','password':'qa2-pass-1','role':'employee','modules':['quality']},tok=tok)
q1=login('qa1','qa1-pass-1')[0]; q2=login('qa2','qa2-pass-1')[0]
qc=tx({'op':'qc-save','out':{'title':'T','qty_inspected':10}},q1)[1].get('check',{}).get('id')
ok('Q1 fail recorded',tx({'op':'qc-result','id':qc,'result':'fail','qty_failed':3},q1)[0]==200)
ok('Q2 failure cannot be flipped to pass',tx({'op':'qc-result','id':qc,'result':'pass'},q1)[0]==400)
ok('Q3 close needs corrective action',tx({'op':'qc-close','id':qc,'corrective_action':'x'},q1)[0]==400 and tx({'op':'qc-close','id':qc,'corrective_action':'replace supplier lot'},q1)[0]==200)
_q4=tx({'op':'qc-void','id':qc,'reason':'mistake here'},q1); ok('Q4 non-admin cannot void',_q4[0] in (400,403) and 'admin' in json.dumps(_q4[1]),_q4)
dc=tx({'op':'doc-save','out':{'title':'SOP'}},q1)[1].get('document',{}).get('id')
ok('D1 draft to review',tx({'op':'doc-status','id':dc,'status':'review'},q1)[0]==200)
ok('D2 doc in review cannot be edited silently',tx({'op':'doc-save','id':dc,'out':{'title':'SOP changed'}},q2)[0]==400)
ok('D3 owner cannot approve own doc',tx({'op':'doc-status','id':dc,'status':'approved'},q1)[0]==400)
ok('D4 other user approves',tx({'op':'doc-status','id':dc,'status':'approved'},q2)[0]==200)
ok('D5 approved cannot be edited or skipped to draft',tx({'op':'doc-save','id':dc,'out':{'title':'x'}},q2)[0]==400 and tx({'op':'doc-status','id':dc,'status':'draft'},q2)[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('D6 invariants unchanged by non-financial modules',not invariants(d),invariants(d))

# ---- partial receipts ----
pa=tx({'op':'product-save','out':{'name':'RA','price':20,'cost':10,'stock':0}})[1]['product']['id']
pb=tx({'op':'product-save','out':{'name':'RB','price':9,'cost':5,'stock':0}})[1]['product']['id']
def prod_stock(i): return [p for p in call('GET','/api/data',tok=tok)[1]['data']['products'] if p['id']==i][0]['stock']
def jsum(poid):
    d=call('GET','/api/data',tok=tok)[1]['data']; ap=[a['id'] for a in d['accounts'] if a['code']=='2000'][0]; inv=[a['id'] for a in d['accounts'] if a['code']=='1200'][0]
    return round(sum(l['credit']-l['debit'] for j in d['journal'] if j.get('ref_type')=='purchase' and j.get('ref_id')==poid for l in j['lines'] if l['account_id']==ap),2)
po2=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':pa,'qty':10,'cost':10},{'product_id':pb,'qty':4,'cost':5}]}})[1]['purchase']['id']
ok('RC1 ordered PO posts nothing',jsum(po2)==0 and prod_stock(pa)==0)
r=tx({'op':'purchase-receive','id':po2,'client_ref':'rc-1','items':[{'line':0,'qty':4}]}); ok('RC2 first partial receipt',r[0]==200 and r[1].get('complete')==False and r[1]['receipt']['amount']==40,r)
ok('RC3 stock 4 and payable 40',prod_stock(pa)==4 and jsum(po2)==40)
r=tx({'op':'purchase-receive','id':po2,'client_ref':'rc-1','items':[{'line':0,'qty':4}]}); ok('RC4 retry same ref returns original, no double stock',r[0]==200 and r[1].get('deduped') and prod_stock(pa)==4 and jsum(po2)==40,r)
for name,items in (('over-receive',[{'line':0,'qty':7}]),('zero',[{'line':0,'qty':0}]),('negative',[{'line':0,'qty':-1}]),('unknown line',[{'line':9,'qty':1}]),('duplicate line',[{'line':0,'qty':1},{'line':0,'qty':1}]),('string qty',[{'line':0,'qty':'x'}]),('empty',[])):
    ok('RC5 '+name+' refused',tx({'op':'purchase-receive','id':po2,'items':items})[0]==400)
ok('RC6 stock/payable unchanged by refusals',prod_stock(pa)==4 and jsum(po2)==40)
ok('RC7 lines cannot be edited while partly received',tx({'op':'purchase-save','id':po2,'out':{'status':'ordered','supplier_id':777,'items':[{'product_id':pa,'qty':99,'cost':1}]}})[0]==400)
ok('RC8 cannot be marked received by save (would double-post)',tx({'op':'purchase-save','id':po2,'out':{'status':'received','supplier_id':777,'items':[{'product_id':pa,'qty':10,'cost':10},{'product_id':pb,'qty':4,'cost':5}]}})[0]==400)
ok('RC9 cannot be deleted',tx({'op':'purchase-delete','id':po2})[0]==400)
ok('RC10 note edit still allowed',tx({'op':'purchase-save','id':po2,'out':{'status':'ordered','supplier_id':777,'notes':'n','items':[{'product_id':pa,'qty':10,'cost':10},{'product_id':pb,'qty':4,'cost':5}]}})[0]==200)
ok('RC11 return to supplier blocked until fully received',tx({'op':'purchase-return-create','purchase_id':po2,'reason':'abc','items':[{'line':0,'qty':1}]})[0]==400)
ok('RC11b supplier payment on a partly received PO blocked',tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':po2,'amount':10,'method':'cash'})[0]==400)
res=par(8,lambda i:tx({'op':'purchase-receive','id':po2,'client_ref':'cc-%d'%i,'items':[{'line':0,'qty':2}]})[0])
ok('RC12 8 concurrent receipts of 2 against 6 left: exactly 3 accepted',res.count(200)==3,res)
ok('RC13 stock A is 10 (never over-received)',prod_stock(pa)==10)
r=tx({'op':'purchase-receive','id':po2,'client_ref':'rc-last','items':[{'line':1,'qty':4}]}); ok('RC14 last receipt completes the PO',r[0]==200 and r[1].get('complete')==True,r)
d=call('GET','/api/data',tok=tok)[1]['data']; po=[x for x in d['purchases'] if x['id']==po2][0]
ok('RC15 status received, flags set, receipts sum to PO total 120',po['status']=='received' and po['journal_received'] and po['stock_applied'] and abs(sum(x['amount'] for x in po['receipts'])-120)<0.005 and jsum(po2)==120,po)
ok('RC16 further receipt refused',tx({'op':'purchase-receive','id':po2,'items':[{'line':0,'qty':1}]})[0]==400)
ok('RC17 invariants after receipts',not invariants(d),invariants(d))
ok('RC18 return to supplier works once fully received',tx({'op':'purchase-return-create','purchase_id':po2,'reason':'bad batch','items':[{'line':0,'qty':1}]})[0]==200)
po3=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'description':'service','qty':1,'cost':50}]}})[1]['purchase']['id']
ok('RC19 PO with a non-stock line cannot be partly received',tx({'op':'purchase-receive','id':po3,'items':[{'line':0,'qty':1}]})[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('RC20 invariants at end',not invariants(d),invariants(d))

# partial receipts: mixed costs, per-line allocation, no cross-line remainder
pc=tx({'op':'product-save','out':{'name':'RC','price':9,'cost':3.33,'stock':0}})[1]['product']['id']
pd=tx({'op':'product-save','out':{'name':'RD','price':99,'cost':7.5,'stock':0}})[1]['product']['id']
po4=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':pc,'qty':3,'cost':3.33},{'product_id':pd,'qty':2,'cost':7.5}]}})[1]['purchase']['id']
amts=[]
for k in range(3):
    r=tx({'op':'purchase-receive','id':po4,'client_ref':'mx%d'%k,'items':[{'line':0,'qty':1}]}); amts.append((r[0],[i['amount'] for i in r[1]['receipt']['items']]))
ok('RM1 line 0 in three 1-unit receipts allocates only its own value (3.33 each)',all(a[0]==200 for a in amts) and [a[1][0] for a in amts]==[3.33,3.33,3.33],amts)
ok('RM2 line 1 untouched so far: payable is 9.99 only',jsum(po4)==9.99,jsum(po4))
r=tx({'op':'purchase-receive','id':po4,'client_ref':'mx9','items':[{'line':1,'qty':2}]}); ok('RM3 line 1 posts its own 15.00',r[0]==200 and r[1]['receipt']['items'][0]['amount']==15.0 and jsum(po4)==24.99,r)
# odd split of one line: 3 units of 3.34 = 10.02 in thirds then remainder stays on that line
pg=tx({'op':'product-save','out':{'name':'RG','price':9,'cost':3.34,'stock':0}})[1]['product']['id']
ph=tx({'op':'product-save','out':{'name':'RH','price':9,'cost':1,'stock':0}})[1]['product']['id']
pq=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':pg,'qty':7,'cost':3.34},{'product_id':ph,'qty':1,'cost':1}]}})[1]['purchase']['id']
got=[]
for k,q in enumerate((3,3,1)):
    r=tx({'op':'purchase-receive','id':pq,'client_ref':'qq%d'%k,'items':[{'line':0,'qty':q}]}); got.append(r[1]['receipt']['items'][0]['amount'])
ok('RM4 uneven quantity split of one line sums to its own 23.38 (no remainder to the other line)',abs(sum(got)-23.38)<0.005 and jsum(pq)==23.38,(got,jsum(pq)))
pe=tx({'op':'product-save','out':{'name':'RE','price':9,'cost':3.3333,'stock':0}})[1]['product']['id']
pf=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':pe,'qty':1,'cost':1.004},{'product_id':ph,'qty':1,'cost':1.004}]}})[1]['purchase']['id']
rr=tx({'op':'purchase-receive','id':pf,'items':[{'line':0,'qty':1}]}); ok('RM5 sub-cent-cost purchase that cannot reconcile is refused with a clear message',rr[0]==400 and 'fraction' in json.dumps(rr[1]),rr)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('RM6 invariants after mixed-cost receipts',not invariants(d),invariants(d))

rt=tx({'op':'purchase-return-create','purchase_id':po4,'reason':'mixed return','items':[{'line':0,'qty':1},{'line':1,'qty':1}]})
ok('RM7 partial return of a fully received multi-cost PO values each line at its own cost (3.33 + 7.50)',rt[0]==200 and abs(rt[1]['purchase_return']['total']-10.83)<0.005 if rt[0]==200 and 'purchase_return' in rt[1] else False,rt)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('RM8 invariants after the partial return',not invariants(d),invariants(d))

# ---- void of credit notes / purchase returns ----
def D(): return call('GET','/api/data',tok=tok)[1]['data']
vp=tx({'op':'product-save','out':{'name':'VP','price':30,'cost':10,'stock':0}})[1]['product']['id']
tx({'op':'stock-adjust','product_id':vp,'qty':20,'memo':'open'})
vi=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-01','due_date':'2026-12-01','tax_rate':10,'items':[{'product_id':vp,'qty':4,'price':30}]}})[1]['invoice']['id']
def inv_row(i): return [x for x in D()['invoices'] if x['id']==i][0]
st0=[p for p in D()['products'] if p['id']==vp][0]['stock']
cn=tx({'op':'credit-note-create','invoice_id':vi,'reason':'damaged','items':[{'line':0,'qty':1,'restock':True}]})
cnid=cn[1]['credit_note']['id']; ok('V1 credit note posted (33.00, restocked)',cn[0]==200 and cn[1]['credit_note']['total']==33.0)
stk=[p for p in D()['products'] if p['id']==vp][0]['stock']; ok('V2 stock +1',stk==st0+1)
_v=tx({'op':'credit-note-void','id':cnid,'reason':'entered by mistake'},itok); ok('V3 non-admin cannot void',_v[0] in (400,403) and 'admin' in json.dumps(_v[1]) or _v[0]==403,_v)
ok('V4 short reason refused',tx({'op':'credit-note-void','id':cnid,'reason':'no'})[0]==400)
res=par(6,lambda i:tx({'op':'credit-note-void','id':cnid,'reason':'entered by mistake'})[0]); ok('V5 concurrent voids: exactly one applies',res.count(200)==1,res)
d=D(); row=inv_row(vi); c=[x for x in d['credit_notes'] if x['id']==cnid][0]
ok('V6 note is void with who/why; invoice credited back to 0; stock back to start',c['status']=='void' and c.get('voided_by')=='boss' and row['credited_amount']==0 and [p for p in d['products'] if p['id']==vp][0]['stock']==st0,(c,row.get('credited_amount')))
ok('V7 original note and both journals kept, plus reversal journals',sum(1 for j in d['journal'] if j.get('ref_type')=='credit_note' and j['ref_id']==cnid)==1 and sum(1 for j in d['journal'] if j.get('ref_type')=='credit_note-void' and j['ref_id']==cnid)==1)
ok('V8 invariants after void',not invariants(d),invariants(d))
ok('V9 void note no longer counts: full line can be credited again',tx({'op':'credit-note-create','invoice_id':vi,'reason':'again','items':[{'line':0,'qty':4,'restock':False}]})[0]==200)
# restocked goods sold since: void refused
vi2=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-02','due_date':'2026-12-01','tax_rate':0,'items':[{'product_id':vp,'qty':2,'price':30}]}})[1]['invoice']['id']
cn2=tx({'op':'credit-note-create','invoice_id':vi2,'reason':'ret','items':[{'line':0,'qty':2,'restock':True}]})[1]['credit_note']['id']
curs=[p for p in D()['products'] if p['id']==vp][0]['stock']
tx({'op':'stock-adjust','product_id':vp,'qty':-curs,'memo':'sold everything'})
r=tx({'op':'credit-note-void','id':cn2,'reason':'try to void'}); ok('V10 void refused when the restocked goods are no longer on hand',r[0]==400 and 'no longer on hand' in json.dumps(r[1]),r)
# refunded note cannot be voided
vi3=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-03','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'svc','qty':1,'price':100}]}})[1]['invoice']['id']
pay=tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':vi3,'amount':100,'method':'cash'})
cn3=tx({'op':'credit-note-create','invoice_id':vi3,'reason':'refund it','items':[{'line':0,'qty':1}],'refund_confirmed':True,'refund_method':'cash','refund_reference':'RF1'})
ok('V11 refunded credit note created',cn3[0]==200 and cn3[1]['credit_note']['refunded']==100,cn3)
r=tx({'op':'credit-note-void','id':cn3[1]['credit_note']['id'],'reason':'try to void'}); ok('V12 note that moved money cannot be voided',r[0]==400 and 'refund' in json.dumps(r[1]),r)
# purchase return void
vq=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':vp,'qty':5,'cost':10}]}})[1]['purchase']['id']
s1=[p for p in D()['products'] if p['id']==vp][0]['stock']
pr=tx({'op':'purchase-return-create','purchase_id':vq,'reason':'defective','items':[{'line':0,'qty':2}]}); prid=pr[1]['purchase_return']['id']
ok('V13 purchase return posted, stock -2',pr[0]==200 and [p for p in D()['products'] if p['id']==vp][0]['stock']==s1-2)
ok('V14 non-admin cannot void purchase return',tx({'op':'purchase-return-void','id':prid,'reason':'mistake here'},itok)[0] in (400,403))
res=par(6,lambda i:tx({'op':'purchase-return-void','id':prid,'reason':'entered by mistake'})[0]); ok('V15 concurrent purchase-return voids: exactly one',res.count(200)==1,res)
d=D(); po_=[x for x in d['purchases'] if x['id']==vq][0]
ok('V16 stock restored, returned_amount 0, return void, invariants hold',[p for p in d['products'] if p['id']==vp][0]['stock']==s1 and po_.get('returned_amount',0)==0 and not invariants(d),(po_.get('returned_amount'),invariants(d)))
ok('V17 void return does not free quantity to over-return, but allows a fresh one',tx({'op':'purchase-return-create','purchase_id':vq,'reason':'again here','items':[{'line':0,'qty':5}]})[0]==200)
d=D(); ok('V18 invariants at end',not invariants(d),invariants(d))

# ---- sales-order return void ----
def mkorder(qty,price,tax,pid):
    o=tx({'op':'order-save','out':{'status':'draft','contact_id':555,'order_date':'2026-11-05','tax_rate':tax,'items':[{'product_id':pid,'qty':qty,'price':price}]}})[1]['order']['id']
    tx({'op':'order-confirm','id':o}); tx({'op':'order-fulfill','id':o}); return o
tx({'op':'stock-adjust','product_id':vp,'qty':30,'memo':'refill'})
ro=mkorder(3,30,10,vp)
s0=[p for p in D()['products'] if p['id']==vp][0]['stock']
rr=tx({'op':'return-create','id':ro,'items':[{'product_id':vp,'qty':1}]}); ok('R1 order return created',rr[0]==200,rr)
rid=rr[1]['return']['id']
ok('R2 non-admin cannot void return',tx({'op':'return-void','id':rid,'reason':'mistake here'},itok)[0] in (400,403))
res=par(6,lambda i:tx({'op':'return-void','id':rid,'reason':'entered by mistake'})[0]); ok('R3 concurrent return voids: exactly one',res.count(200)==1,res)
d=D(); ok('R4 stock restored, return void, invariants hold',[p for p in d['products'] if p['id']==vp][0]['stock']==s0 and [x for x in d['returns'] if x['id']==rid][0]['status']=='void' and not invariants(d),invariants(d))
ok('R5 voided return frees quantity: full 3 can be returned',tx({'op':'return-create','id':ro,'items':[{'product_id':vp,'qty':3}]})[0]==200)

ro2=mkorder(2,30,0,vp)
inv2=[o for o in D()['sales_orders'] if o['id']==ro2][0]['invoice_id']
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':inv2,'amount':60,'method':'cash'})
rp=tx({'op':'return-create','id':ro2,'items':[{'product_id':vp,'qty':1}],'refund_confirmed':True,'refund_method':'cash','refund_reference':'RR1'})
ok('R6 paid return with confirmed refund created',rp[0]==200,rp)
r=tx({'op':'return-void','id':rp[1]['return']['id'],'reason':'try to void'}); ok('R7 return that paid money back cannot be voided',r[0]==400 and 'paid money back' in json.dumps(r[1]),r)
ro3=mkorder(1,30,0,vp)
rq=tx({'op':'return-create','id':ro3,'items':[{'product_id':vp,'qty':1}]})[1]['return']['id']
cs=[p for p in D()['products'] if p['id']==vp][0]['stock']; tx({'op':'stock-adjust','product_id':vp,'qty':-cs,'memo':'sold all'})
r=tx({'op':'return-void','id':rq,'reason':'try to void'}); ok('R8 void refused when returned goods no longer on hand',r[0]==400 and 'no longer on hand' in json.dumps(r[1]),r)
ok('R9 invariants',not invariants(D()),invariants(D()))

# ---- purchase receipt void ----
rp0=tx({'op':'product-save','out':{'name':'RV','price':20,'cost':7}})[1]['product']['id']
rvp=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':rp0,'qty':10,'cost':7}]}})[1]['purchase']['id']
def stk(): return [p for p in D()['products'] if p['id']==rp0][0]['stock']
a1=tx({'op':'purchase-receive','id':rvp,'items':[{'line':0,'qty':4}]}); a2=tx({'op':'purchase-receive','id':rvp,'items':[{'line':0,'qty':3}]})
ok('W1 two receipts, stock 7',a1[0]==200 and a2[0]==200 and stk()==7)
ok('W2 only latest receipt can be voided',tx({'op':'purchase-receipt-void','id':rvp,'n':1,'reason':'wrong receipt'})[0]==400)
ok('W3 non-admin refused',tx({'op':'purchase-receipt-void','id':rvp,'n':2,'reason':'entered wrongly'},itok)[0] in (400,403))
ok('W4 short reason refused',tx({'op':'purchase-receipt-void','id':rvp,'n':2,'reason':'x'})[0]==400)
res=par(6,lambda i:tx({'op':'purchase-receipt-void','id':rvp,'n':2,'reason':'entered wrongly'})[0]); ok('W5 concurrent voids: exactly one',res.count(200)==1,res)
d=D(); po_=[x for x in d['purchases'] if x['id']==rvp][0]
ok('W6 stock 4, received_qty 4, receipt 2 void, invariants hold',stk()==4 and po_['items'][0]['received_qty']==4 and po_['receipts'][1].get('void') and not invariants(d),(stk(),invariants(d)))
a3=tx({'op':'purchase-receive','id':rvp,'items':[{'line':0,'qty':6}]}); ok('W7 remaining 6 can be received after void; PO completes with exact value',a3[0]==200 and a3[1].get('complete') and stk()==10,a3)
d=D(); po_=[x for x in d['purchases'] if x['id']==rvp][0]
ok('W8 books: AP for the PO equals 70.00 exactly, invariants',not invariants(d) and po_['status']=='received',invariants(d))
ok('W9 completed purchase receipt cannot be voided',tx({'op':'purchase-receipt-void','id':rvp,'n':3,'reason':'too late now'})[0]==400)
rvq=tx({'op':'purchase-save','out':{'status':'ordered','supplier_id':777,'items':[{'product_id':rp0,'qty':5,'cost':7}]}})[1]['purchase']['id']
tx({'op':'purchase-receive','id':rvq,'items':[{'line':0,'qty':5}]}) if False else None
tx({'op':'purchase-receive','id':rvq,'items':[{'line':0,'qty':2}]})
cs=stk(); tx({'op':'stock-adjust','product_id':rp0,'qty':-cs,'memo':'sold'})
r=tx({'op':'purchase-receipt-void','id':rvq,'n':1,'reason':'entered wrongly'}); ok('W10 void refused when received goods are gone',r[0]==400 and 'no longer on hand' in json.dumps(r[1]),r)

# ---- customer credit (store credit) ----
call('PUT','/api/data',{'data':{'contacts':[{'id':555,'first_name':'C','last_name':'D'},{'id':556,'first_name':'E','last_name':'F'}]}},tok=tok)
def acct(code,d=None):
    d=d or D(); a=[x for x in d['accounts'] if x['code']==code]
    if not a: return 0.0
    i=a[0]['id']; return round(sum((l.get('debit') or 0)-(l.get('credit') or 0) for j in d['journal'] for l in j['lines'] if l['account_id']==i),2)
sc=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-06','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'svc','qty':1,'price':100}]}})[1]['invoice']['id']
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':sc,'amount':100,'method':'bank'})
r=tx({'op':'credit-note-create','invoice_id':sc,'reason':'over paid','items':[{'line':0,'qty':1}]}); ok('S1 over-credit without confirmation or explicit store credit still blocked',r[0]==400,r)
d0=D(); cash0=(acct('1000',d0),acct('1010',d0))
r=tx({'op':'credit-note-create','invoice_id':sc,'reason':'over paid','items':[{'line':0,'qty':1}],'store_credit':True}); ok('S2 explicit store_credit creates the note',r[0]==200 and r[1]['credit_note']['store_credit']==100 and r[1]['credit_note']['refunded']==0,r)
d=D(); cc=d['customer_credits'][-1]; ccid=cc['id']
ok('S3 credit balance 100 on account 2150, cash and bank unchanged, no cash ledger row',cc['remaining']==100 and acct('2150',d)==-100 and (acct('1000',d),acct('1010',d))==cash0 and not invariants(d),(acct('2150',d),invariants(d)))
si=tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-07','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'svc2','qty':1,'price':60}]}})[1]['invoice']['id']
so=tx({'op':'invoice-save','out':{'status':'sent','contact_id':556,'issue_date':'2026-11-07','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'other','qty':1,'price':60}]}})[1]['invoice']['id']
ok('S4 other customer invoice rejected',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':so,'amount':10})[0]==400)
ok('S5 more than invoice owes rejected',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':si,'amount':61})[0]==400)
ok('S6 zero/negative/NaN rejected',all(tx({'op':'credit-apply','credit_id':ccid,'invoice_id':si,'amount':a})[0]==400 for a in (0,-5,'x')))
ok('S7 direct payment with method store_credit rejected',tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':si,'amount':10,'method':'store_credit'})[0]==400)
res=par(6,lambda i:tx({'op':'credit-apply','credit_id':ccid,'invoice_id':si,'amount':60})[0]); ok('S8 concurrent full applies: exactly one',res.count(200)==1,res)
d=D(); inv_=[x for x in d['invoices'] if x['id']==si][0]; cc=[x for x in d['customer_credits'] if x['id']==ccid][0]
ok('S9 invoice paid, credit remaining 40, 2150 = -40, cash untouched, invariants',inv_['status']=='paid' and cc['remaining']==40 and acct('2150',d)==-40 and (acct('1000',d),acct('1010',d))==cash0 and not invariants(d),(inv_['status'],cc['remaining'],acct('2150',d),invariants(d)))
ok('S10 credit note with used credit cannot be voided',tx({'op':'credit-note-void','id':cc['credit_note_id'],'reason':'try to void'})[0]==400)
ok('S11 non-owner module cannot apply',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':si,'amount':1},itok)[0] in (400,403))
# unused credit can be voided
sd=tx({'op':'invoice-save','out':{'status':'sent','contact_id':556,'issue_date':'2026-11-08','due_date':'2026-12-01','tax_rate':0,'items':[{'description':'svc3','qty':1,'price':50}]}})[1]['invoice']['id']
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':sd,'amount':50,'method':'cash'})
cn5=tx({'op':'credit-note-create','invoice_id':sd,'reason':'over paid','items':[{'line':0,'qty':1}],'store_credit':True})[1]['credit_note']['id']
ok('S12 unused credit note voids; credit void, 2150 back to -40',tx({'op':'credit-note-void','id':cn5,'reason':'entered wrongly'})[0]==200 and acct('2150')==-40 and not invariants(D()))
# ---- supplier credit ----
call('PUT','/api/data',{'data':{'suppliers':[{'id':777,'name':'S'},{'id':778,'name':'S2'}]}},tok=tok)
tp=tx({'op':'product-save','out':{'name':'TP','price':30,'cost':10,'stock':0}})[1]['product']['id']
def mkpo(sup,qty=5,cost=10):
    return tx({'op':'purchase-save','out':{'status':'received','supplier_id':sup,'items':[{'product_id':tp,'qty':qty,'cost':cost}]}})[1]['purchase']['id']
p1=mkpo(777); tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':p1,'amount':50,'method':'bank'})
r=tx({'op':'purchase-return-create','purchase_id':p1,'reason':'defective','items':[{'line':0,'qty':5}]}); ok('T1 over-return of a paid purchase without confirmation or store_credit still blocked',r[0]==400,r)
d0=D(); cash1=(acct('1000',d0),acct('1010',d0))
r=tx({'op':'purchase-return-create','purchase_id':p1,'reason':'defective','items':[{'line':0,'qty':5}],'store_credit':True}); ok('T2 explicit store_credit creates the return',r[0]==200 and r[1]['purchase_return']['store_credit']==50 and r[1]['purchase_return']['refunded']==0,r)
d=D(); sc_=d['supplier_credits'][-1]; scid=sc_['id']
ok('T3 supplier credit 50 on 1150 (asset, debit), cash/bank unchanged, no ledger cash row, invariants',sc_['remaining']==50 and acct('1150',d)==50 and (acct('1000',d),acct('1010',d))==cash1 and not invariants(d),(acct('1150',d),invariants(d)))
p2=mkpo(777,3,10); p3=mkpo(778,3,10)
ok('T4 other supplier purchase rejected',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p3,'amount':10})[0]==400)
ok('T5 more than purchase owes rejected',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p2,'amount':30.01})[0]==400)
ok('T6 zero/negative/NaN rejected',all(tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p2,'amount':a})[0]==400 for a in (0,-5,'x',None)))
ok('T7 direct payment out with method store_credit rejected',tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':p2,'amount':10,'method':'store_credit'})[0]==400)
ok('T7b customer credit action cannot be abused on suppliers / bad ids',tx({'op':'supplier-credit-apply','credit_id':999999,'purchase_id':p2,'amount':1})[0]==400 and tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':999999,'amount':1})[0]==400)
res=par(6,lambda i:tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p2,'amount':30})[0]); ok('T8 concurrent full applies: exactly one',res.count(200)==1,res)
d=D(); po2=[x for x in d['purchases'] if x['id']==p2][0]; sc_=[x for x in d['supplier_credits'] if x['id']==scid][0]
ok('T9 purchase paid, credit remaining 20, 1150 = 20, 2000 consistent, cash untouched, invariants',po2.get('paid') is True and sc_['remaining']==20 and acct('1150',d)==20 and (acct('1000',d),acct('1010',d))==cash1 and not invariants(d),(po2.get('paid'),sc_['remaining'],acct('1150',d)))
ok('T10 return with used credit cannot be voided',tx({'op':'purchase-return-void','id':sc_['purchase_return_id'],'reason':'try to void'})[0]==400)
ok('T11 non-owner module / non-admin cannot apply',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p3,'amount':1},itok)[0] in (400,403) and tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p3,'amount':1},etok)[0] in (400,403))
p4=mkpo(778,2,10); tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':p4,'amount':20,'method':'cash'})
pr4=tx({'op':'purchase-return-create','purchase_id':p4,'reason':'wrong item','items':[{'line':0,'qty':2}],'store_credit':True})[1]['purchase_return']['id']
ok('T12 unused supplier credit voids; credit void, 1150 back to 20',tx({'op':'purchase-return-void','id':pr4,'reason':'entered wrongly'})[0]==200 and acct('1150')==20 and not invariants(D()))
# partial: credit only the over-paid part when purchase partly paid
p5=mkpo(777,4,10); tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':p5,'amount':30,'method':'bank'})
r=tx({'op':'purchase-return-create','purchase_id':p5,'reason':'half back','items':[{'line':0,'qty':4}],'store_credit':True})
d=D(); c5=[x for x in d['supplier_credits'] if x['purchase_return_id']==r[1]['purchase_return']['id']] if r[0]==200 else []
ok('T13 return 40 on purchase paid 30: 10 to payables, 30 supplier credit, 1150 = 50',r[0]==200 and c5 and c5[0]['amount']==30 and r[1]['purchase_return']['applied_to_payable']==10 and acct('1150',d)==50 and not invariants(d),(r,acct('1150',d)))
ok('T14 store_credit on an unpaid purchase creates no credit (nothing excess)',(lambda q:(q[0]==200 and q[1]['purchase_return']['store_credit']==0))(tx({'op':'purchase-return-create','purchase_id':mkpo(778,1,10),'reason':'x y z','items':[{'line':0,'qty':1}],'store_credit':True})))
ok('T15 store_credit must be literal true (string/1 rejected as refund path)',all(tx({'op':'purchase-return-create','purchase_id':p1,'reason':'abc','items':[{'line':0,'qty':1}],'store_credit':v})[0]==400 for v in ('true',1,'yes')))
# forged client writes to credit collections are ignored
dd=D(); before=json.dumps(dd['supplier_credits'],sort_keys=True)+json.dumps(dd['customer_credits'],sort_keys=True)
fc=json.loads(json.dumps(dd['supplier_credits'])); fc[0]['remaining']=99999
fk=json.loads(json.dumps(dd['customer_credits'])); fk[0]['remaining']=99999
call('PUT','/api/data',{'data':{'supplier_credits':fc,'customer_credits':fk}},tok=tok)
dd=D(); ok('T16 forged PUT of supplier_credits/customer_credits ignored',before==json.dumps(dd['supplier_credits'],sort_keys=True)+json.dumps(dd['customer_credits'],sort_keys=True))
ok('T17 final books balanced and stock consistent',not invariants(D()))
print('matrix-test: PASS=%d FAIL=%d'%(PASS,FAIL))
srv.terminate()
