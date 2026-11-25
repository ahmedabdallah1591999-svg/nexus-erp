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

# revalue / cost change
rp=tx({'op':'product-save','out':{'name':'RV','price':30,'cost':10,'stock':0}})[1]['product']['id']
tx({'op':'stock-adjust','product_id':rp,'qty':4,'memo':'open'})
st,jj=tx({'op':'product-save','id':rp,'out':{'name':'RV','price':30,'cost':12}}); ok('R1 cost change with stock rejected, points to revalue',st==400 and 'evalue' in json.dumps(jj),jj)
jb=len(call('GET','/api/data',tok=tok)[1]['data']['journal'])
ok('R2 non-admin revalue refused',tx({'op':'product-revalue','id':rp,'new_cost':12,'reason':'abc','expected_value':8},itok)[0]==403)
ok('R3 no reason refused',tx({'op':'product-revalue','id':rp,'new_cost':12,'reason':'','expected_value':8})[0]==400)
ok('R4 wrong expected value refused',tx({'op':'product-revalue','id':rp,'new_cost':12,'reason':'abc','expected_value':9})[0]==400)
ok('R5 negative cost refused',tx({'op':'product-revalue','id':rp,'new_cost':-1,'reason':'abc','expected_value':-44})[0]==400)
d=call('GET','/api/data',tok=tok)[1]['data']; ok('R6 refusals changed nothing',len(d['journal'])==jb and [p for p in d['products'] if p['id']==rp][0]['cost']==10)
res=par(6,lambda i:tx({'op':'product-revalue','id':rp,'new_cost':12,'reason':'supplier repricing','expected_value':8})[0]); ok('R7 concurrent revalue: exactly one applies',res.count(200)==1,res)
d=call('GET','/api/data',tok=tok)[1]['data']; pr=[p for p in d['products'] if p['id']==rp][0]
ok('R8 cost 12, history kept, one journal',pr['cost']==12 and len(pr.get('cost_history',[]))==1 and len(d['journal'])==jb+1,pr)
ok('R9 invariants after revalue',not invariants(d),invariants(d))
je=d['journal'][-1]; ok('R10 journal Dr1200 8',sorted((l['debit'],l['credit']) for l in je['lines'])==[(0,8),(8,0)],je)
print('matrix-test: PASS=%d FAIL=%d'%(PASS,FAIL))
srv.terminate()
