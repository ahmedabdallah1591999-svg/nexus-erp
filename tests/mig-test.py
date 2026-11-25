# Self-contained reconstruction of the inventory-adjustment migration checks (mig-battery A-I2, original source
# in tests/mig-battery.sh). The old-style store is synthesized here: real accounts and users from a fresh server,
# then journal/stock history rewritten to the pre-inventory-posting shape (1 sales entry, stock with no postings).
import json, subprocess, time, os, shutil, hashlib, urllib.request, urllib.error, glob
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
def start(port,data):
    subprocess.run('pkill -f "node server.js"',shell=True); time.sleep(1)
    p=subprocess.Popen(['node','server.js'],cwd='/tmp/nexus-erp',env=dict(os.environ,PORT=str(port),DATA_DIR=data),stdout=open('/tmp/mg-srv.log','a'),stderr=subprocess.STDOUT); time.sleep(1.5); return p
sha=lambda f:hashlib.sha256(open(f,'rb').read()).hexdigest()
def make_old(dst,seed=False,journal=True):
    shutil.rmtree(dst,ignore_errors=True); os.makedirs(dst)
    srv=start(8700,dst); B='http://localhost:8700'
    code=open(dst+'/setup-code').read().strip()
    call(B,'POST','/api/setup',{'username':'admin','password':'admin1234','code':code})
    tok=call(B,'POST','/api/login',{'username':'admin','password':'admin1234'})[1]['token']
    call(B,'PUT','/api/data',{'data':{'contacts':[{'id':1,'first_name':'Old','last_name':'Customer'}]}},tok=tok)
    for n,c,s in (('Old A',10,30),('Old B',20,14)): call(B,'POST','/api/tx',{'op':'product-save','out':{'name':n,'price':c*3,'cost':c,'stock':s}},tok)   # value 300 + 280 = 580
    srv.terminate(); time.sleep(1)
    st=json.load(open(dst+'/store.json')); d=st['data']
    acc={a['code']:a['id'] for a in d['accounts']}
    # old-style: stock exists with NO inventory postings and no stock ledger; one old sales entry only
    d['stock_moves']=[]; d['journal']=[]; d['invoices']=[]; d['ledger']=[]
    if journal:
        d['journal']=[{'id':1,'date':'2026-10-01','memo':'old sale','ref_type':'invoice','ref_id':1,'lines':[{'account_id':acc['1100'],'debit':100,'credit':0},{'account_id':acc['4000'],'debit':0,'credit':100}]}]
    else:
        d['accounts']=[]
    d['meta']['nextId']=max(d['meta'].get('nextId',1),500)
    if seed: d['settings']={'seed_demo':True}
    json.dump(st,open(dst+'/store.json','w')); return st
def login(B): return call(B,'POST','/api/login',{'username':'admin','password':'admin1234'})[1]['token']
def acct_bal(d,code):
    a=[x for x in d['accounts'] if x['code']==code]
    return round(sum((l.get('debit') or 0)-(l.get('credit') or 0) for j in d['journal'] for l in j['lines'] if a and l['account_id']==a[0]['id']),2)
stockval=lambda d:round(sum(p.get('stock',0)*p.get('cost',0) for p in d['products']),2)
INV={'op':'invoice-save','out':{'status':'sent','contact_id':1,'issue_date':'2026-11-24','tax_rate':0,'items':[{'product_id':None,'qty':1,'price':50}]}}
# ---------------- A-H: old-style store with history + stock gap
D='/tmp/mgd1'; make_old(D)
h0=sha(D+'/store.json'); B='http://localhost:8701'; srv=start(8701,D)
ok('A startup leaves store.json byte-identical (no auto-post, no save)',sha(D+'/store.json')==h0)
ok('A2 no backup file at startup',not glob.glob(D+'/*backup*'))
tok=login(B); ok('B admin login',bool(tok))
d=call(B,'GET','/api/data',tok=tok)[1]['data']; pid=d['products'][0]['id']
inv=json.loads(json.dumps(INV)); inv['out']['items'][0]['product_id']=pid
r=call(B,'POST','/api/tx',inv,tok)
ok('C posting blocked with 400 and names the reconciliation',r[0]==400 and ('reconcil' in json.dumps(r[1]).lower() or 'inventory' in json.dumps(r[1]).lower()),r)
ok('C3 failed tx leaves store.json unchanged',sha(D+'/store.json')==h0)
call(B,'POST','/api/users',{'username':'emp1','password':'emp12345','role':'employee','modules':['accounting','invoices','products']},tok=tok)
etok=call(B,'POST','/api/login',{'username':'emp1','password':'emp12345'})[1]['token']
r=call(B,'POST','/api/tx',{'op':'migrate-inventory'},etok); ok('D non-admin migrate rejected',r[0]!=200,r)
ok('D2 journal still 1 entry (no auto-post)',len(json.load(open(D+'/store.json'))['data']['journal'])==1)
r=call(B,'POST','/api/tx',{'op':'migrate-inventory'},tok)
ok('E admin approve posts once, gap = stock value 580',r[0]==200 and r[1].get('posted') is True and abs(r[1].get('gap',0)-580)<0.01,r)
ok('E2 backup created',len(glob.glob(D+'/*pre-inventory-adjustment-backup'))==1)
ok('E3 backup holds the pre-adjustment journal (1 entry)',len(json.load(open(glob.glob(D+'/*pre-inventory-adjustment-backup')[0]))['data']['journal'])==1)
st=json.load(open(D+'/store.json'))['data']
ok('E4 exactly one migration entry; original sales entry untouched',len([j for j in st['journal'] if j['ref_type']=='migration'])==1 and st['journal'][0]['memo']=='old sale')
ok('E5 inventory GL == stock valuation at cost',abs(acct_bal(st,'1200')-stockval(st))<0.01,(acct_bal(st,'1200'),stockval(st)))
mig=[j for j in st['journal'] if j['ref_type']=='migration'][0]; eq=[a['id'] for a in st['accounts'] if a['code']=='3000'][0]
ok('E6 migration entry is Dr Inventory / Cr Owner equity (no income/expense effect)',any(l['account_id']==eq and l['credit']>0 for l in mig['lines']))
r=call(B,'POST','/api/tx',{'op':'migrate-inventory'},tok); ok('F second approve posts nothing',r[1].get('posted') is False,r)
ok('F2 journal unchanged (2 entries)',len(json.load(open(D+'/store.json'))['data']['journal'])==2)
r=call(B,'POST','/api/tx',inv,tok); ok('G posting unblocked after approval',r[0]==200,r)
srv.terminate(); time.sleep(1); srv=start(8701,D); tok=login(B)
d=call(B,'GET','/api/data',tok=tok)[1]['data']
ok('H invoice and migration entry persist across restart',len(d['invoices'])==1 and len([j for j in d['journal'] if j['ref_type']=='migration'])==1)
# COGS then sane: 1200 still equals stock valuation after the sale
ok('H2 after the sale inventory GL still == stock valuation',abs(acct_bal(d,'1200')-stockval(d))<0.01,(acct_bal(d,'1200'),stockval(d)))
srv.terminate()
# ---------------- I1: existing stock, empty journal, NO seed marker -> review path, no automatic opening
D='/tmp/mgd3'; make_old(D,journal=False); srv=start(8703,D); B='http://localhost:8703'; tok=login(B)
r=call(B,'POST','/api/tx',{'op':'migrate-inventory'},tok)
st=json.load(open(D+'/store.json'))['data']
ok('I1 empty journal does NOT auto-open: adjustment proposed and posted only on admin approval',r[0]==200 and r[1].get('posted') is True,r)
ok('I1b no automatic opening entry',len([j for j in st['journal'] if j['ref_type']=='opening'])==0)
ok('I1c backup preserved on approval',len(glob.glob(D+'/*backup*'))==1)
srv.terminate()
# ---------------- I2: explicitly marked synthetic seed -> opening established automatically
D='/tmp/mgd5'; make_old(D,seed=True,journal=False); srv=start(8705,D); B='http://localhost:8705'; tok=login(B)
r=call(B,'POST','/api/tx',{'op':'migrate-inventory'},tok)
st=json.load(open(D+'/store.json'))['data']
ok('I2 marked seed: nothing left to adjust',r[0]==200 and r[1].get('posted') is False,r)
ok('I2b explicit opening entry exists',len([j for j in st['journal'] if j['ref_type']=='opening'])==1,[j['ref_type'] for j in st['journal']])
ok('I2c no adjustment backup on the fresh path',not glob.glob(D+'/*backup*'))
ok('I2d inventory GL == stock valuation',abs(acct_bal(st,'1200')-stockval(st))<0.01,(acct_bal(st,'1200'),stockval(st)))
srv.terminate(); subprocess.run('pkill -f "node server.js"',shell=True)
print('mig-test: PASS=%d FAIL=%d'%(PASS,FAIL))
