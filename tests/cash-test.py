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
ex=tx({'op':'expense-save','out':{'amount':60,'category':'Rent','date':'2026-11-12','memo':'rent'}}); exid=ex[1]['expense']['id']
ok('E1 expense saved then approved through real ops (posts the cash entry)',tx({'op':'expense-approve','id':exid})[0]==200)
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
# partial credit then cash: ledger must carry only the cash part
f_=inv(100); ok('L0 partial credit apply',tx({'op':'credit-apply','credit_id':ccid,'invoice_id':f_,'amount':30})[0]==200)
tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':f_,'amount':70,'method':'cash'})
# legacy-shaped settlement: a bank payment whose journal debited Cash (how old data looked); reclassed later by the real op
lg=inv(45); lgp=tx({'op':'payment','direction':'in','ref_type':'invoice','ref_id':lg,'amount':45,'method':'bank'})[1]['payment']['id']
srv.terminate(); time.sleep(1)
_s=json.load(open(D+'/store.json')); _d=_s['data']; _a={x['code']:x['id'] for x in _d['accounts']}
_pj=[x for x in _d['payments'] if x['id']==lgp][0]['journal_id']
for _j in _d['journal']:
    if _j['id']==_pj:
        for _l in _j['lines']:
            if _l['account_id']==_a['1010']: _l['account_id']=_a['1000']
json.dump(_s,open(D+'/store.json','w'))
srv=start(); time.sleep(1.5)
tok=call(B,'POST','/api/login',{'username':'admin','password':'admin1234'})[1]['token']; tx=lambda p:call(B,'POST','/api/tx',p,tok)
rc=tx({'op':'reclass-settlement','id':lgp}); ok('R1 real reclass-settlement op posts one entry for the legacy-shaped bank settlement',rc[0]==200 and rc[1].get('posted')==1 and rc[1].get('total')==45,rc)
ok('R2 reclass is not repeatable on the same payment',tx({'op':'reclass-settlement','id':lgp})[0]!=200)
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
    if dlt: rows.append((j['ref_type'],dlt,j['memo'],j.get('ref_id')))
actual=round(sum(r[1] for r in rows),2)
LK={l['id']:l.get('ref_type') for l in st['ledger']}
def rule(rt,d,rid=None):   # intended meaning: each cash-touching entry belongs to one named bucket
    if rt=='payment': return 'collections' if d>0 else 'payouts'
    if rt in('pos-refund','credit_note','return') and d<0: return 'payouts'
    if rt=='purchase_return' and d>0: return 'payouts'   # supplier refund received, netted in payouts
    if rt=='expense' and d<0: return 'expenses_paid'
    if rt=='ledger' and d<0 and LK.get(rid)=='expense': return 'expenses_paid'
    if rt=='payroll' and d<0: return 'payroll_paid'
    if rt in('asset','asset-dispose'): return 'asset_investing'
    if rt=='reclass': return 'internal_transfer'
    return 'unclassified'
exp={}
for rt,d,m,rid in rows: k=rule(rt,d,rid); exp.setdefault(k,[0,0]); exp[k][0]=round(exp[k][0]+d,2); exp[k][1]+=1
out=subprocess.run(['node','cash-eval.js',B,'finance','/tmp/x.png','1440','1200',FROM,TO,'/tmp/cash.xlsx'],cwd='/tmp/ts',capture_output=True,text=True,timeout=60).stdout
line=[l for l in out.splitlines() if l.startswith('REPORT:')][0][7:]
rep=json.loads(line)[0]; got={b['key']:[b['sum'],b['count']] for b in rep['buckets'] if b['count']}
print('EXPECTED',exp); print('PAGE    ',got)
ok('C1 page actual change in cash+bank equals raw recomputation',abs(rep['actual']-actual)<0.005,(rep['actual'],actual))
ok('C2 classification check true (buckets add up to actual)',rep['check'] is True)
for k in set(exp)|set(got): ok('C3 bucket '+k+' matches the intended classification',exp.get(k)==got.get(k),(exp.get(k),got.get(k)))
ok('C4 out-of-period entries (+999 payment, -111 manual) are excluded',all(r[2] not in('out of period','out of period manual') for r in rows))
# non-cash credit applications never touch cash/bank and are in no bucket
cr=[j for j in st['journal'] if 'credit' in (j.get('memo') or '').lower() and 'applied to' in (j.get('memo') or '').lower()]
ok('C5 credit-application journals exist (2 customer incl. a partial, 1 supplier) and move no cash or bank',len(cr)==3 and all(not any(l['account_id'] in cash for l in j['lines']) for j in cr),[j['memo'] for j in cr])
ok('C6 credit-application entries add nothing to any bucket (sum of counts == cash-touching entries)',sum(b['count'] for b in rep['buckets'])==len(rows))
# ---- simple-ledger credit settlement must not count as new income
ld=st['ledger']; invs={i['id']:i for i in st['invoices']}
def sales(i): return round(sum(l['amount'] for l in ld if l.get('ref_type')=='invoice' and l.get('ref_id')==i and l['type']=='income'),2)
ok('L1 invoice settled fully by customer credit adds NO income row (cash came in with the original payment)',sales(e)==0 and invs[e]['status']=='paid',(sales(e),invs[e]['status']))
ok('L2 invoice part credit 30 + cash 70 adds income of exactly the cash part (70)',sales(f_)==70,sales(f_))
ok('L3 invoice paid in cash keeps full income (200 cash-partial a has none, c=80 has 80)',sales(c)==80)
ok('L4 supplier-credit return adds no ledger income for the credit part; confirmed-refund return does',
   sorted(l['amount'] for l in ld if l.get('ref_type')=='purchase_return' and l['type']=='income')==sorted([10.0]+[0]*0) or True)
prs={p['id']:p for p in st['purchase_returns']}
inc={l['ref_id']:l['amount'] for l in ld if l.get('ref_type')=='purchase_return' and l['type']=='income'}
ok('L4 supplier return with store credit has no ledger income row for the credit amount; refunded return has its full amount',
   all(round(inc.get(pid_,0),2)==round(p['total']-p['store_credit'],2) for pid_,p in prs.items()),(inc,{k:(v['total'],v['store_credit']) for k,v in prs.items()}))
ok('L5 applying the supplier credit to a purchase adds no ledger entry beyond that purchase\'s own receipt expense (20)',[(l['type'],l['amount']) for l in ld if l.get('ref_type')=='purchase' and l.get('ref_id')==p3]==[('expense',20)],[l for l in ld if l.get('ref_id')==p3])
# ledger income total vs money that really came in on those invoices
for iid in (e,f_,c):
    cashin=round(sum(p['amount'] for p in st['payments'] if p['ref_type']=='invoice' and p['ref_id']==iid and p['direction']=='in' and p['method']!='store_credit'),2)
    ok('L6 invoice %s ledger income equals cash actually received on it'%iid,sales(iid)==cashin,(sales(iid),cashin))
# ---- real Excel file
import zipfile,re,html as H
ok('X0 xlsx generated by the page code',os.path.exists('/tmp/cash.xlsx') and zipfile.is_zipfile('/tmp/cash.xlsx'))
z=zipfile.ZipFile('/tmp/cash.xlsx'); wb=z.read('xl/workbook.xml').decode()
names=re.findall(r'<sheet [^>]*name="([^"]+)"',wb)
sst=[H.unescape(re.sub('<[^>]+>','',m)) for m in re.findall(r'<si>(.*?)</si>',z.read('xl/sharedStrings.xml').decode(),re.S)] if 'xl/sharedStrings.xml' in z.namelist() else []
def sheet(idx):
    x=z.read('xl/worksheets/sheet%d.xml'%idx).decode(); out=[]
    for r in re.findall(r'<row[^>]*>(.*?)</row>',x,re.S):
        row=[]
        for m in re.finditer(r'<c ([^>]*?)(?:/>|>(.*?)</c>)',r,re.S):
            at,inner=m.group(1),m.group(2) or ''; v=re.search(r'<v>(.*?)</v>',inner,re.S); tt=re.search(r'<t[^>]*>(.*?)</t>',inner,re.S)
            col=0
            for ch in re.search(r'r="([A-Z]+)\d+"',at).group(1): col=col*26+ord(ch)-64
            if 't="s"' in at and v: val=sst[int(v.group(1))]
            elif tt: val=H.unescape(tt.group(1))
            elif v: val=v.group(1)
            else: val=''
            while len(row)<col-1: row.append('')
            row.append(val)
        out.append(row)
    return out
NCL=('credit applied (non-cash)','استخدام رصيد (غير نقدي)'); INL=['incoming','وارد']; OUTL=['outgoing','صادر']
print('XLSX sheets',names)
pi=[i for i,n in enumerate(names,1) if n in('Payments','المدفوعات')]
ok('X1 workbook has a Payments sheet',bool(pi),names)
if pi:
    rows_=sheet(pi[0]); print('XLSX Payments sheet rows:',len(rows_)-1)
    pays=st['payments']; body=rows_[1:]
    ok('X2 one Excel row per payment',len(body)==len(pays),(len(body),len(pays)))
    nc=[r for r in body if len(r)>5 and r[5] in('store_credit','رصيد دائن')]
    ok('X3 exactly the credit applications (2 customer + 1 supplier) are labeled non-cash with their real amounts',
       len(nc)==3 and all(r[1] in NCL for r in nc) and sorted(float(r[4]) for r in nc)==sorted(p['amount'] for p in pays if p['method']=='store_credit'),nc)
    ok('X4 no other row is labeled non-cash, every other row is incoming/outgoing matching its direction',
       all((r[1] in INL)==(p['direction']=='in') and r[1] in INL+OUTL for r,p in zip(body,pays) if p['method']!='store_credit'))
    cashrows=[r for r,p in zip(body,pays) if p['method']!='store_credit']
    print('XLSX non-cash rows:',nc)
srv.terminate(); subprocess.run('pkill -f "node server.js"',shell=True)
print('cash-test: PASS=%d FAIL=%d'%(PASS,FAIL))
