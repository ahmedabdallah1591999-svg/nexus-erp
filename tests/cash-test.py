# Self-contained cash-flow classification check (reconstructs ca-test intent; original source tests/ca-test.sh).
# Fixture: real ops for every shape the app produces that touches cash, plus synthetic journal shapes injected
# offline (payroll, asset buy/dispose, reclass, non-cash production/depr/opening, out-of-period, unclassified manual).
# Expectations come from an independent rule table written below, then the PAGE code (cashMovementReport run in a
# real headless Chrome) is compared with it and with a raw recomputation of actual cash+bank movement.
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
D='/tmp/cashd'; B='http://localhost:8711'
shutil.rmtree(D,ignore_errors=True); os.makedirs(D)
def start():
    subprocess.run('pkill -f "node server.js"',shell=True); time.sleep(1)
    return subprocess.Popen(['node','server.js'],cwd='/tmp/nexus-erp',env=dict(os.environ,PORT='8711',DATA_DIR=D),stdout=open('/tmp/cash-srv.log','a'),stderr=subprocess.STDOUT)
srv=start(); time.sleep(1.5)
call(B,'POST','/api/setup',{'username':'admin','password':'admin1234','code':open(D+'/setup-code').read().strip()})
tok=call(B,'POST','/api/login',{'username':'admin','password':'admin1234'})[1]['token']
tx=lambda p:call(B,'POST','/api/tx',p,tok)
call(B,'PUT','/api/data',{'data':{'suppliers':[{'id':777,'name':'S'}],'contacts':[{'id':555,'first_name':'C','last_name':'D'}]}},tok=tok)
pid=tx({'op':'product-save','out':{'name':'W','price':30,'cost':10,'stock':40}})[1]['product']['id']
def inv(price,qty=1):
    return tx({'op':'invoice-save','out':{'status':'sent','contact_id':555,'issue_date':'2026-11-10','due_date':'2026-12-10','tax_rate':0,'items':[{'description':'svc','qty':qty,'price':price}]}})[1]['invoice']['id']
a=inv(200); tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':a,'amount':100,'method':'cash'}); tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':a,'amount':40,'method':'bank'})
po=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':5,'cost':10}]}})[1]['purchase']['id']
tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':po,'amount':30,'method':'bank'})
tx({'op':'expense-save','out':{'description':'rent','amount':60,'category':'Rent','date':'2026-11-12','status':'paid'}})
sh=tx({'op':'pos-shift-open','opening_float':0})[1].get('shift',{}).get('id')
ps=tx({'op':'pos-sale','client_ref':'c-1','shift_id':sh,'method':'cash','items':[{'product_id':pid,'qty':1,'price':30}]}); posid=(ps[1].get('invoice') or {}).get('id')
if posid: tx({'op':'pos-refund','id':posid})
# customer: credit-note with a confirmed cash refund; store credit note; apply
b=inv(100); tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':b,'amount':100,'method':'bank'})
r=tx({'op':'credit-note-create','invoice_id':b,'reason':'refund it','items':[{'line':0,'qty':1}],'refund_confirmed':True,'refund_method':'bank','refund_reference':'TR-1'}); ok('F1 confirmed customer refund note created',r[0]==200,r)
c=inv(80); tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':c,'amount':80,'method':'cash'})
tx({'op':'credit-note-create','invoice_id':c,'reason':'keep as credit','items':[{'line':0,'qty':1}],'store_credit':True})
d=call(B,'GET','/api/data',tok=tok)[1]['data']; ccid=d['customer_credits'][0]['id']
e=inv(50); ok('F2 customer credit applied',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':e,'amount':50})[0]==200)
# supplier: confirmed refund return; store-credit return; apply
p2=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':4,'cost':10}]}})[1]['purchase']['id']
tx({'op':'payment','direction':'out','ref_type':'purchase','ref_id':p2,'amount':40,'method':'cash'})
r=tx({'op':'purchase-return-create','purchase_id':p2,'reason':'refund back','items':[{'line':0,'qty':1}],'refund_confirmed':True,'refund_method':'bank','refund_reference':'SR-1'}); ok('F3 confirmed supplier refund return created',r[0]==200,r)
r=tx({'op':'purchase-return-create','purchase_id':p2,'reason':'keep credit','items':[{'line':0,'qty':2}],'store_credit':True}); ok('F4 supplier credit return',r[0]==200,r)
d=call(B,'GET','/api/data',tok=tok)[1]['data']; scid=d['supplier_credits'][0]['id']
p3=tx({'op':'purchase-save','out':{'status':'received','supplier_id':777,'items':[{'product_id':pid,'qty':2,'cost':10}]}})[1]['purchase']['id']
ok('F5 supplier credit applied',tx({'op':'supplier-credit-apply','credit_id':scid,'purchase_id':p3,'amount':15})[0]==200)
srv.terminate(); time.sleep(1)
# ---- inject synthetic shapes offline (documented): ids of accounts by code
st=json.load(open(D+'/store.json')); dd=st['data']; acc={a['code']:a['id'] for a in dd['accounts']}
nid=max(j['id'] for j in dd['journal'])+1
def add(date,rt,lines,memo='synthetic'):
    global nid
    dd['journal'].append({'id':nid,'date':date,'memo':memo,'ref_type':rt,'ref_id':None,'lines':[{'account_id':acc[c],'debit':dr,'credit':cr} for c,dr,cr in lines]}); nid+=1
today=datetime.date.today().isoformat()
add(today,'payroll',[('6100',400,0),('1010',0,400)])
add(today,'asset',[('1500',600,0),('1010',0,600)]) if '1500' in acc else add(today,'asset',[('1200',600,0),('1010',0,600)])
add(today,'asset-dispose',[('1010',100,0),('1200',0,100)])
add(today,'reclass',[('1010',25,0),('1000',0,25)])
add(today,'production',[('1200',50,0),('1200',0,50)])
add(today,'asset-depr',[('6900',20,0),('1200',0,20)])
add(today,None,[('1000',60,0),('4100',0,60)],'manual unclassified cash in')
add('2026-01-05','payment',[('1000',999,0),('1100',0,999)],'out of period')
add('2026-01-06',None,[('1010',0,111),('6900',111,0)],'out of period manual')
json.dump(st,open(D+'/store.json','w'))
srv=start(); time.sleep(1.5)
# ---- independent expectation from the raw store
st=json.load(open(D+'/store.json'))['data']; cash={a['id'] for a in st['accounts'] if a['code'] in('1000','1010')}
FROM,TO='2026-11-01',today
rows=[]
for j in st['journal']:
    if not (FROM<=j['date']<=TO): continue
    dlt=round(sum((l['debit'] or 0)-(l['credit'] or 0) for l in j['lines'] if l['account_id'] in cash),2)
    if dlt: rows.append((j['ref_type'],dlt,j['memo']))
actual=round(sum(r[1] for r in rows),2)
def rule(rt,d):   # intended meaning: each cash-touching entry belongs to one named bucket
    if rt=='payment': return 'collections' if d>0 else 'payouts'
    if rt in('pos-refund','credit_note','return') and d<0: return 'payouts'
    if rt=='purchase_return' and d>0: return 'payouts'   # supplier refund received, netted in payouts
    if rt=='expense' and d<0: return 'expenses_paid'
    if rt=='payroll' and d<0: return 'payroll_paid'
    if rt in('asset','asset-dispose'): return 'asset_investing'
    if rt=='reclass': return 'internal_transfer'
    return 'unclassified'
exp={}
for rt,d,m in rows: exp.setdefault(rule(rt,d),[0,0]); exp[rule(rt,d)][0]=round(exp[rule(rt,d)][0]+d,2); exp[rule(rt,d)][1]+=1
out=subprocess.run(['node','cash-eval.js',B,'finance','/tmp/x.png','1440','1200',FROM,TO],cwd='/tmp/ts',capture_output=True,text=True,timeout=60).stdout
line=[l for l in out.splitlines() if l.startswith('REPORT:')][0][7:]
rep=json.loads(line)[0]; got={b['key']:[b['sum'],b['count']] for b in rep['buckets'] if b['count']}
print('EXPECTED',exp); print('PAGE    ',got)
ok('C1 page actual change in cash+bank equals raw recomputation',abs(rep['actual']-actual)<0.005,(rep['actual'],actual))
ok('C2 classification check true (buckets add up to actual)',rep['check'] is True)
for k in set(exp)|set(got): ok('C3 bucket '+k+' matches the intended classification',exp.get(k)==got.get(k),(exp.get(k),got.get(k)))
ok('C4 out-of-period entries (+999 payment, -111 manual) are excluded',all(r[2] not in('out of period','out of period manual') for r in rows))
# non-cash credit applications never touch cash/bank and are in no bucket
cr=[j for j in st['journal'] if 'credit' in (j.get('memo') or '').lower() and 'applied to' in (j.get('memo') or '').lower()]
ok('C5 credit-application journals exist (customer and supplier) and move no cash or bank',len(cr)==2 and all(not any(l['account_id'] in cash for l in j['lines']) for j in cr),[j['memo'] for j in cr])
ok('C6 credit-application entries add nothing to any bucket (sum of counts == cash-touching entries)',sum(b['count'] for b in rep['buckets'])==len(rows))
srv.terminate(); subprocess.run('pkill -f "node server.js"',shell=True)
print('cash-test: PASS=%d FAIL=%d'%(PASS,FAIL))
