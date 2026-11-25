'use strict';
/* tx.js — server-authoritative business transactions.
 *
 * The server, not the browser, computes every derived record: journal
 * entries, stock moves, payments, invoice/purchase/quote status changes,
 * protected product stock. Clients send an OPERATION (sell this, receive
 * this, pay this); the server validates the actor's permission for that
 * operation, runs the SAME business logic the browser ships (loaded into a
 * Node VM, so behavior cannot diverge), checks the accounting and stock
 * invariants on the result, and only then commits — atomically, serialized
 * through one queue so concurrent requests (e.g. two quote conversions)
 * cannot interleave.
 *
 * Derived collections (accounts, journal, payments, warehouses,
 * stock_moves, ledger) and protected fields on operational records
 * (status, paid_amount, stock, posting flags) are server-owned: the
 * generic whole-data PUT refuses to carry them, so a forged client cannot
 * write them directly.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MODULE_FILES = ['i18n.js', 'i18n-extra.js', 'core.js', 'seed.js', 'crm.js',
  'sales.js', 'quotes.js', 'orders.js', 'accounting.js', 'payments.js', 'stock.js', 'finance.js'];

/* Collections only the server may write (never accepted from a client PUT). */
/* a real calendar date (YYYY-MM-DD), not just the right shape */
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
}
const MAXAMT = 1e12;
/* test seam only: lets the automated suites simulate future periods. Never set in normal use. */
const FUTURE_OK = process.env.NEXUS_TEST_ALLOW_FUTURE === '1' && process.env.NEXUS_TEST_HARNESS === 'nexus-automated-suite';

const SERVER_OWNED = new Set(['accounts', 'journal', 'payments', 'warehouses', 'stock_moves',
  'ledger', 'invoices', 'purchases', 'quotes', 'products', 'sales_orders', 'returns', 'recurring', 'expenses', 'projects', 'timesheets',
  'tickets', 'ticket_replies', 'leave_requests', 'attendance', 'assets', 'pos_shifts', 'production', 'quality_checks', 'documents', 'credit_notes', 'purchase_returns']);

/* ---------------- browser sandbox ---------------- */

function domStub() {
  const el = () => ({
    style: {}, value: '', textContent: '', innerHTML: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [], focus() {}, click() {},
    closest: () => null, dataset: {},
  });
  return {
    getElementById: el, querySelector: el, querySelectorAll: () => [],
    createElement: el, createTextNode: () => ({}), addEventListener() {}, removeEventListener() {},
    body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} },
    documentElement: { lang: 'en', dir: 'ltr' }, hidden: false,
  };
}

function makeSandbox() {
  const mem = {};
  const storage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
  };
  const sandbox = {
    console, JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Set, Map,
    Promise, Error, TypeError, RangeError, parseFloat, parseInt, isNaN, isFinite, Intl,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: storage, sessionStorage: storage,
    document: domStub(), navigator: { language: 'en' },
    location: { hash: '', href: 'http://tx.local/' }, history: { replaceState() {} },
    alert: () => {}, confirm: () => true, prompt: () => null,
    fetch: () => Promise.reject(new Error('network unavailable in server tx')),
    requestAnimationFrame: fn => setTimeout(fn, 0),
    Blob: class Blob {}, FileReader: class FileReader {}, JSZip: undefined, XLSX: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of MODULE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  /* const/let top-level bindings live in the context's declarative scope,
     not on the global object — capture them explicitly. */
  const api = vm.runInContext(`({
    store, num, todayStr, monthStr, t, applyStock, saveInvoice, purchaseTotal,
    convertQuoteToInvoice, recordPayment, postJournal, reverseJournal,
    adjustStock, transferStock, ensureCOA, ensureStockBaseline,
    accountingInvariants, stockInvariants, accountByCode, invoiceTotal,
    postInvoiceSentJournal, postPurchaseReceivedJournal, postPayrollJournal,
    productWarehouseStock, recordStockMove, postOpeningStockJournal,
    applyReturnEffects, returnedQty, invoiceOpenAmount, inventoryGap,
    advanceDate, accumDepr, accountCode, purchaseOpenAmount, settlementAccountId, PAYMENT_METHODS, returnSplit, invoiceCreditedTotal,
  })`, sandbox);
  return api;
}

/* ---------------- operation handlers ----------------
   Each receives (ctx, payload) where ctx is the sandbox with store.data set
   from the live db. Handlers return a result object or throw a TxError. */

class TxError extends Error {
  constructor(msg) { super(msg); this.txError = true; }
}

const num0 = v => Number(v) || 0;
/* A refund is money that actually moved. Choosing a method is not proof:
   the reviewer must confirm it was sent/received and give a reference.
   There is no credit-balance model yet, so an unconfirmed over-credit is
   blocked rather than posted. */
function confirmedRefund(ctx, p, excess, who, side) {
  const methods = ctx.PAYMENT_METHODS;
  const owed = side === 'customer'
    ? `This is ${excess.toFixed(2)} more than the customer still owes (they already paid it). A refund is recorded only after the money has actually been sent back: confirm it was sent, choose how (${methods.join(', ')}) and enter its reference. Otherwise lower the quantity to the unpaid part. Store credit / credit balances are not supported yet.`
    : `This is ${excess.toFixed(2)} more than we still owe the supplier (we already paid it). A refund is recorded only after the supplier has actually paid it back: confirm it was received, choose how (${methods.join(', ')}) and enter its reference. Otherwise lower the quantity to the unpaid part, or record the return after the refund arrives. Supplier credit balances are not supported yet.`;
  need(p.refund_confirmed === true && methods.includes(p.refund_method) && String(p.refund_reference || '').trim().length >= 2, owed);
  return { method: p.refund_method, reference: String(p.refund_reference).trim(), by: (who && who.username) || null };
}
/* quantity of a product already credited on an invoice by credit notes
   and by sales-order returns, so mixed histories cannot over-credit */
function creditedProductQty(S, inv, pid) {
  let q = 0;
  for (const cn of (S.data.credit_notes || []).filter(x => x.invoice_id === inv.id && x.status !== 'void')) for (const it of cn.items) if ((it.product_id == null ? null : Number(it.product_id)) === pid) q += Number(it.qty);
  for (const r of (S.data.returns || []).filter(x => x.invoice_id === inv.id && x.status !== 'void')) for (const it of (r.items || [])) if ((it.product_id == null ? null : Number(it.product_id)) === pid) q += Number(it.qty);
  return q;
}
function invoicedProductQty(inv, pid) {
  return inv.items.filter(it => (it.product_id == null ? null : Number(it.product_id)) === pid).reduce((s, it) => s + Number(it.qty), 0);
}
function need(cond, msg) { if (!cond) throw new TxError(msg); }

/* remove fields a client may never set on a record (identity, numbering,
   links and flags that only other transactions write) */
function stripServerFields(out, keys) { for (const k of keys) delete out[k]; return out; }
/* keep only the named fields of a client payload (allowlist) */
function pick(obj, keys) { const r = {}; for (const k of keys) if (obj && obj[k] !== undefined) r[k] = obj[k]; return r; }

function validItems(items, S) {
  need(Array.isArray(items) && items.length > 0, 'items required');
  need(items.length <= 500, 'too many lines');
  for (const it of items) {
    need(it && typeof it === 'object', 'bad line');
    need(Number.isFinite(Number(it.qty)) && Number(it.qty) > 0 && Number(it.qty) <= 1e9, 'qty must be positive');
    need(Number.isFinite(Number(it.price != null ? it.price : it.cost)) && Number(it.price != null ? it.price : it.cost) >= 0 && Number(it.price != null ? it.price : it.cost) <= 1e12, 'price must not be negative');
    /* a line that names a product must name a real one — otherwise stock
       side effects would silently no-op while flags say they happened */
    if (it.product_id != null) {
      need(S.data.products.some(x => x.id === Number(it.product_id)), 'unknown product in line items');
      it.product_id = Number(it.product_id);
    }
  }
  /* keep only the known line fields, as numbers: no extra keys are stored */
  items.splice(0, items.length, ...items.map(it => {
    const r = { product_id: it.product_id == null ? null : it.product_id, description: String(it.description || '').slice(0, 500), qty: Number(it.qty) };
    if (it.price != null) r.price = Number(it.price);
    if (it.cost != null) r.cost = Number(it.cost);
    return r;
  }));
}

/* strict quantity: a finite number or numeric string in (0, 1e9]; rejects
   booleans, arrays, null, '', NaN, Infinity */
function qcQty(v, label) {
  const ok = (typeof v === 'number') || (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v));
  const n = ok ? Number(v) : NaN;
  need(Number.isFinite(n) && n > 0 && n <= 1e9, `${label} must be a number above 0 and at most 1,000,000,000`);
  return Math.round(n * 1000) / 1000;
}

const OPS = {
  'invoice-save': {
    view: 'invoices',
    run(ctx, p) {
      const raw = p.out || {};
      need(['draft', 'sent', 'paid'].includes(raw.status), 'bad status');
      const S = ctx.store;
      validItems(raw.items, S);
      need(ctx.num(raw.tax_rate) >= 0 && ctx.num(raw.tax_rate) <= 100, 'bad tax rate');
      need(raw.contact_id == null || raw.contact_id === '' || S.data.contacts.some(c => c.id === Number(raw.contact_id)), 'customer not found');
      /* only these client fields are read; number and every posting flag
         (stock_applied, journal_*, ledger_posted) are server-owned */
      const out = {
        status: raw.status, contact_id: raw.contact_id ? Number(raw.contact_id) : null,
        deal_id: raw.deal_id ? Number(raw.deal_id) : null,
        issue_date: raw.issue_date, due_date: raw.due_date, tax_rate: ctx.num(raw.tax_rate),
        notes: String(raw.notes || ''), items: raw.items,
      };
      let existing = null;
      if (p.id != null) {
        existing = S.data.invoices.find(i => i.id === Number(p.id));
        need(existing, 'invoice not found');
        const posted = existing.status !== 'draft' || existing.stock_applied || existing.journal_sent;
        if (posted) {
          /* a posted invoice is accounting history: lines, customer, tax and
             issue date are locked, and it cannot go back to draft or from
             paid to sent. Allowed: notes, due date, deal link, sent -> paid. */
          const eq = (x, y) => Math.abs(Number(x) - Number(y)) < 1e-9;
          const same = (out.contact_id || null) === (existing.contact_id || null) && eq(out.tax_rate, existing.tax_rate || 0)
            && out.issue_date === existing.issue_date && out.items.length === existing.items.length
            && out.items.every((it, i) => (it.product_id == null ? null : Number(it.product_id)) === (existing.items[i].product_id == null ? null : Number(existing.items[i].product_id))
              && eq(it.qty, existing.items[i].qty) && eq(it.price, existing.items[i].price));
          need(same, 'a posted invoice cannot be changed: its lines, customer, tax and date are locked');
          need(!(out.status === 'paid' && existing.status !== 'paid' && num0(existing.credited_amount) > 0 && ctx.invoiceOpenAmount(existing) <= 0.005), 'this invoice is fully settled by credit notes; nothing is left to pay');
          need(out.status === existing.status || (existing.status === 'sent' && out.status === 'paid'), 'a posted invoice cannot go back to an earlier status');
        }
      }
      /* stock availability when the invoice would leave draft */
      const willApply = out.status !== 'draft' && !(existing && existing.stock_applied);
      if (willApply) {
        for (const it of out.items) {
          const prod = S.data.products.find(x => x.id === it.product_id);
          if (prod) need(ctx.num(prod.stock) >= ctx.num(it.qty), `insufficient stock for ${prod.name}`);
        }
      }
      ctx.saveInvoice(existing, out);
      const inv = existing || S.data.invoices[S.data.invoices.length - 1];
      return { invoice: inv };
    },
  },

  'invoice-delete': {
    view: 'invoices',
    run(ctx, p) {
      const S = ctx.store;
      const inv = S.data.invoices.find(i => i.id === Number(p.id));
      need(inv, 'invoice not found');
      /* posted invoices are accounting history: reverse, don't erase.
         Drafts never posted anything and can be removed. */
      need(inv.status === 'draft' && !inv.journal_sent, 'only draft invoices can be deleted; reverse posted invoices instead');
      if (inv.stock_applied) ctx.applyStock(inv.items, +1, { reason: 'invoice-delete', ref_type: 'invoice', ref_id: inv.id });
      /* time billed onto this draft becomes billable again */
      for (const t of (S.data.timesheets || [])) if (t.billed_invoice_id === inv.id) t.billed_invoice_id = null;
      S.remove('invoices', inv.id);
      return { deleted: inv.id };
    },
  },

  'quote-save': {
    view: 'quotes',
    run(ctx, p) {
      const out = pick(p.out, ['status', 'contact_id', 'deal_id', 'issue_date', 'valid_until', 'tax_rate', 'notes', 'items']);
      need(['draft', 'sent', 'accepted', 'rejected'].includes(out.status), 'bad status');
      const S = ctx.store;
      validItems(out.items, S);
      need(ctx.num(out.tax_rate) >= 0 && ctx.num(out.tax_rate) <= 100, 'bad tax rate');
      let q;
      if (p.id != null) {
        q = S.data.quotes.find(x => x.id === Number(p.id));
        need(q, 'quote not found');
        need(!q.invoiced_invoice_id, 'converted quotes are locked');
        Object.assign(q, out);
        S.save();
      } else {
        S.data.meta.quoteSeq = S.data.meta.quoteSeq || 1;
        out.number = `Q-${String(S.data.meta.quoteSeq).padStart(4, '0')}`;
        S.data.meta.quoteSeq++;
        q = S.add('quotes', out);
      }
      return { quote: q };
    },
  },

  'quote-convert': {
    view: 'quotes',
    run(ctx, p) {
      const S = ctx.store;
      const q = S.data.quotes.find(x => x.id === Number(p.id));
      need(q, 'quote not found');
      /* server-side single-convert guarantee; the queue serializes races */
      need(!q.invoiced_invoice_id, 'quote already converted');
      ctx.convertQuoteToInvoice(q);
      need(q.invoiced_invoice_id, 'conversion failed');
      return { quote: q, invoice_id: q.invoiced_invoice_id };
    },
  },

  'quote-delete': {
    view: 'quotes',
    run(ctx, p) {
      const S = ctx.store;
      const q = S.data.quotes.find(x => x.id === Number(p.id));
      need(q, 'quote not found');
      need(!q.invoiced_invoice_id, 'converted quotes are locked');
      S.remove('quotes', q.id);
      return { deleted: q.id };
    },
  },

  'payment': {
    view: 'payments',
    run(ctx, p) {
      need(['in', 'out'].includes(p.direction), 'bad direction');
      need(Number(p.amount) > 0, 'amount must be positive');
      const row = ctx.recordPayment(p);
      need(row, 'payment rejected: check reference, status and open balance');
      return { payment: row };
    },
  },

  'journal': {
    view: 'accounting',
    run(ctx, p) {
      need(p.date == null || p.date === '' || validDate(p.date), 'date must be a real YYYY-MM-DD date');
      need(Array.isArray(p.lines) && p.lines.length <= 200 && p.lines.every(l => l && typeof l === 'object'), 'journal lines must be a list of line objects');
      const e = ctx.postJournal({ date: p.date, memo: p.memo, lines: p.lines });
      need(e, 'journal entry must have at least two lines and balance');
      return { entry: e };
    },
  },

  'journal-reverse': {
    view: 'accounting',
    run(ctx, p) {
      const src = ctx.store.data.journal.find(j => j.id === Number(p.id));
      need(src, 'journal entry not found');
      /* only a manual entry may be reversed here: an entry created by a document (invoice, payment,
         return, stock, payroll...) must be corrected through that document, otherwise the books and
         the document disagree. A reversal can be reversed only once, and a reversal itself is final. */
      need(!src.ref_type, 'this entry belongs to a document; correct it through that document (credit note, return, etc.)');
      need(!src.reverses, 'a reversal entry cannot be reversed again; post a new entry instead');
      need(!ctx.store.data.journal.some(j => j.reverses === src.id || (!j.ref_type && String(j.memo || '').startsWith(`${ctx.t('Reversal of')} #${src.id} `))), 'this entry is already reversed');
      const e = ctx.reverseJournal(src.id);
      need(e, 'reversal failed');
      e.reverses = src.id;
      return { entry: e, reverses: src.id };
    },
  },

  'stock-adjust': {
    view: 'stock',
    run(ctx, p) {
      need(Number(p.qty) !== 0 && Math.abs(Number(p.qty)) <= 1e9, 'qty must be a non-zero number');
      if (Number(p.qty) < 0) {
        /* a write-off posts to the books: it needs a stated reason and cannot take stock below zero */
        need(String(p.memo || '').trim().length >= 3, 'a reason is required to reduce stock');
        const pr = ctx.store.data.products.find(x => x.id === Number(p.product_id));
        need(pr && ctx.num(pr.stock) + Number(p.qty) >= -1e-9, 'cannot reduce stock below zero');
        const wh = Number(p.warehouse_id) || (ctx.store.data.warehouses[0] || {}).id;
        const have = ctx.store.data.stock_moves.filter(m => m.product_id === pr.id && m.warehouse_id === wh).reduce((a, m) => a + ctx.num(m.qty), 0);
        need(have + Number(p.qty) >= -1e-9, 'cannot reduce this warehouse below zero');
      }
      const row = ctx.adjustStock(Number(p.product_id), Number(p.warehouse_id) || null, ctx.num(p.qty), p.memo || '');
      need(row, 'adjustment rejected');
      return { move: row };
    },
  },

  'stock-transfer': {
    view: 'stock',
    run(ctx, p) {
      need(Number(p.qty) > 0 && Number(p.qty) <= 1e9, 'qty must be positive');
      const row = ctx.transferStock(Number(p.product_id), Number(p.from), Number(p.to), ctx.num(p.qty));
      need(row, 'transfer rejected: check warehouses and availability');
      return { move: row };
    },
  },

  'warehouse-add': {
    view: 'stock',
    run(ctx, p) {
      need(String(p.name || '').trim(), 'name required');
      const row = ctx.store.add('warehouses', { name: String(p.name).trim(), location: String(p.location || '') });
      ctx.store.save();
      return { warehouse: row };
    },
  },

  'ledger-entry': {
    view: 'finance',
    run(ctx, p) {
      need(['income', 'expense'].includes(p.type), 'bad type');
      need(Number(p.amount) > 0 && Number(p.amount) <= MAXAMT, 'amount must be positive');
      need(p.date == null || p.date === '' || validDate(p.date), 'date must be a real YYYY-MM-DD date');
      const S = ctx.store;
      const row = S.add('ledger', {
        date: p.date || ctx.todayStr(), type: p.type, category: String(p.category || 'Other'),
        amount: Math.round(ctx.num(p.amount) * 100) / 100, ref_type: null, ref_id: null, memo: String(p.memo || ''),
      });
      /* keep the accrual book in step: cash in/out against income/expense */
      const amt = row.amount;
      const debit = p.type === 'income' ? '1000' : '6000';
      const credit = p.type === 'income' ? '4100' : '1000';
      ctx.postJournal({
        date: row.date, memo: row.memo || row.category, ref_type: 'ledger', ref_id: row.id,
        lines: [
          { account_id: ctx.accountByCode(debit).id, debit: amt },
          { account_id: ctx.accountByCode(credit).id, credit: amt },
        ],
      });
      S.save();
      return { entry: row };
    },
  },

  'project-save': {
    view: 'projects',
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      need(String(out.name || '').trim(), 'name required');
      need(!out.contact_id || S.data.contacts.some(c => c.id === Number(out.contact_id)), 'customer not found');
      const rate = Math.round(ctx.num(out.hourly_rate) * 100) / 100;
      need(rate >= 0, 'hourly rate must not be negative');
      if (p.id || out.id) {
        const pr = (S.data.projects || []).find(x => x.id === Number(p.id || out.id));
        need(pr, 'project not found');
        Object.assign(pr, {
          name: String(out.name).trim(), contact_id: out.contact_id || null,
          status: ['active', 'on-hold', 'done'].includes(out.status) ? out.status : pr.status,
          start_date: out.start_date || pr.start_date, due_date: out.due_date || '',
          budget_hours: ctx.num(out.budget_hours), hourly_rate: rate,
          description: String(out.description || ''),
        });
        S.save();
        return { project: pr };
      }
      const row = S.add('projects', {
        name: String(out.name).trim(), contact_id: out.contact_id || null, status: 'active',
        start_date: out.start_date || ctx.todayStr(), due_date: out.due_date || '',
        budget_hours: ctx.num(out.budget_hours), hourly_rate: rate,
        description: String(out.description || ''), created_by: user.username,
      });
      S.save();
      return { project: row };
    },
  },
  'project-delete': {
    view: 'projects',
    run(ctx, p, user) {
      const S = ctx.store;
      const pr = (S.data.projects || []).find(x => x.id === Number(p.id));
      need(pr, 'project not found');
      /* a project with logged time is billing history — remove the time
         first (only possible while unbilled) rather than orphaning rows */
      need(!(S.data.timesheets || []).some(t => t.project_id === pr.id), 'project has logged time and cannot be deleted');
      S.data.projects = S.data.projects.filter(x => x.id !== pr.id);
      S.save();
      return { deleted: pr.id };
    },
  },
  'timesheet-save': {
    view: 'projects',
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const hours = Math.round(ctx.num(out.hours) * 100) / 100;
      need(hours > 0 && hours <= 24, 'hours must be between 0 and 24 per entry');
      need(out.date == null || out.date === '' || validDate(out.date), 'date must be a real YYYY-MM-DD date');
      const pr = (S.data.projects || []).find(x => x.id === Number(out.project_id));
      need(pr, 'project not found');
      if (p.id || out.id) {
        const ts = (S.data.timesheets || []).find(x => x.id === Number(p.id || out.id));
        need(ts, 'timesheet not found');
        need(!ts.billed_invoice_id, 'billed time cannot be edited');
        need(user.role === 'admin' || ts.employee === user.username, 'only the logger can edit it');
        Object.assign(ts, { date: out.date || ts.date, hours, description: String(out.description || ''), billable: !!out.billable });
        S.save();
        return { entry: ts };
      }
      /* employee identity comes from the session, never the payload */
      const row = S.add('timesheets', {
        project_id: pr.id, employee: user.username, date: out.date || ctx.todayStr(),
        hours, description: String(out.description || ''), billable: !!out.billable,
        billed_invoice_id: null,
      });
      S.save();
      return { entry: row };
    },
  },
  'timesheet-delete': {
    view: 'projects',
    run(ctx, p, user) {
      const S = ctx.store;
      const ts = (S.data.timesheets || []).find(x => x.id === Number(p.id));
      need(ts, 'timesheet not found');
      need(!ts.billed_invoice_id, 'billed time cannot be deleted');
      need(user.role === 'admin' || ts.employee === user.username, 'only the logger can delete it');
      S.data.timesheets = S.data.timesheets.filter(x => x.id !== ts.id);
      S.save();
      return { deleted: ts.id };
    },
  },
  'timesheet-invoice': {
    view: 'projects',
    run(ctx, p, user) {
      /* billing also needs the invoices module — it creates a real document */
      need(user.role === 'admin' || (user.modules || []).includes('invoices'), 'invoices access required to bill time');
      const S = ctx.store;
      const pr = (S.data.projects || []).find(x => x.id === Number(p.project_id));
      need(pr, 'project not found');
      need(pr.contact_id, 'project has no customer to bill');
      const rate = ctx.num(pr.hourly_rate);
      need(rate > 0, 'project has no hourly rate');
      const unbilled = (S.data.timesheets || []).filter(t => t.project_id === pr.id && t.billable && !t.billed_invoice_id);
      need(unbilled.length > 0, 'no unbilled billable time');
      /* the invoice is a DRAFT: sending (which posts accounting) stays an
         explicit, separately-authorized operation */
      ctx.saveInvoice(null, {
        status: 'draft', contact_id: pr.contact_id, deal_id: null,
        issue_date: ctx.todayStr(), due_date: ctx.todayStr(),
        tax_rate: 0, notes: `${ctx.t('Project')} ${pr.name}`,
        items: unbilled.map(t => ({
          product_id: null,
          description: `${t.date} — ${t.description || ctx.t('Time')} (${t.hours}h × ${rate})`,
          qty: t.hours, price: rate,
        })),
      });
      const inv = S.data.invoices[S.data.invoices.length - 1];
      for (const t of unbilled) t.billed_invoice_id = inv.id;
      S.save();
      return { invoice: inv, billed: unbilled.length };
    },
  },
  'expense-save': {
    view: ['finance', 'expenses'],
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const amount = Math.round(ctx.num(out.amount) * 100) / 100;
      need(amount > 0 && amount <= MAXAMT, 'amount must be positive');
      need(out.date == null || out.date === '' || validDate(out.date), 'date must be a real YYYY-MM-DD date');
      if (p.id || out.id) {
        const e = (S.data.expenses || []).find(x => x.id === Number(p.id || out.id));
        need(e, 'expense not found');
        need(e.status === 'submitted', 'only a submitted expense can be edited');
        need(user.role === 'admin' || e.submitted_by === user.username, 'only the submitter can edit it');
        Object.assign(e, { date: out.date || e.date, category: String(out.category || e.category), amount, memo: String(out.memo || e.memo || '') });
        S.save();
        return { expense: e };
      }
      const row = S.add('expenses', {
        date: out.date || ctx.todayStr(), category: String(out.category || 'Other'), amount,
        memo: String(out.memo || ''), status: 'submitted', submitted_by: user.username,
        reviewed_by: null, reviewed_at: null, ledger_id: null,
      });
      S.save();
      return { expense: row };
    },
  },
  'expense-approve': {
    view: 'finance',
    run(ctx, p, user) {
      /* approval is the posting event: the ledger entry and its journal exist
         only after an authorized review. Separation of duties: an employee
         cannot approve their own expense; the admin (owner) can. */
      const S = ctx.store;
      const e = (S.data.expenses || []).find(x => x.id === Number(p.id));
      need(e, 'expense not found');
      need(e.status === 'submitted', 'expense is not awaiting approval');
      need(user.role === 'admin' || e.submitted_by !== user.username, 'you cannot approve your own expense');
      const entry = S.add('ledger', {
        date: e.date, type: 'expense', category: e.category, amount: e.amount,
        ref_type: 'expense', ref_id: e.id, memo: e.memo || e.category,
      });
      ctx.postJournal({
        date: entry.date, memo: entry.memo, ref_type: 'ledger', ref_id: entry.id,
        lines: [
          { account_id: ctx.accountByCode('6000').id, debit: entry.amount },
          { account_id: ctx.accountByCode('1000').id, credit: entry.amount },
        ],
      });
      e.status = 'approved'; e.reviewed_by = user.username; e.reviewed_at = ctx.todayStr(); e.ledger_id = entry.id;
      S.save();
      return { expense: e, entry };
    },
  },
  'expense-reject': {
    view: 'finance',
    run(ctx, p, user) {
      const S = ctx.store;
      const e = (S.data.expenses || []).find(x => x.id === Number(p.id));
      need(e, 'expense not found');
      need(e.status === 'submitted', 'expense is not awaiting approval');
      need(user.role === 'admin' || e.submitted_by !== user.username, 'you cannot reject your own expense');
      e.status = 'rejected'; e.reviewed_by = user.username; e.reviewed_at = ctx.todayStr();
      e.reject_reason = String(p.reason || '');
      S.save();
      return { expense: e };
    },
  },
  'expense-delete': {
    view: ['finance', 'expenses'],
    run(ctx, p, user) {
      const S = ctx.store;
      const e = (S.data.expenses || []).find(x => x.id === Number(p.id));
      need(e, 'expense not found');
      need(e.status === 'submitted', 'only a submitted expense can be deleted');
      need(user.role === 'admin' || e.submitted_by === user.username, 'only the submitter can delete it');
      S.data.expenses = S.data.expenses.filter(x => x.id !== e.id);
      S.save();
      return { deleted: e.id };
    },
  },
  'payroll': {
    view: 'finance',
    run(ctx, p, user) {
      /* payroll posts every salary at once: owner-only, one run per month, no future months */
      need(user && user.role === 'admin', 'only an admin can run payroll');
      const S = ctx.store;
      const m = String(p.month || ctx.monthStr());
      need(/^\d{4}-(0[1-9]|1[0-2])$/.test(m), 'month must be YYYY-MM');
      need(FUTURE_OK || m <= ctx.monthStr(), 'payroll cannot be run for a future month');
      /* a prior run is recognised by its month marker, by the salary memo, or (older rows) by the posting date */
      const already = S.data.ledger.some(l => l.type === 'expense' && l.category === 'Payroll' &&
        (l.payroll_month === m || String(l.memo || '').startsWith(`Salary ${m} -`) || (!l.payroll_month && (l.date || '').startsWith(m))));
      need(!already, 'payroll for this month is already posted');
      const active = S.data.employees.filter(e => e.status === 'active');
      need(active.length, 'no active employees');
      need(active.every(e => Number.isFinite(ctx.num(e.salary)) && ctx.num(e.salary) >= 0), 'an employee has an invalid salary');
      const total = active.reduce((s, e) => s + ctx.num(e.salary), 0);
      need(total > 0, 'total salaries are zero; nothing to post');
      active.forEach(e => {
        S.add('ledger', { date: ctx.todayStr(), type: 'expense', category: 'Payroll', amount: ctx.num(e.salary), ref_type: 'payroll', ref_id: e.id, payroll_month: m, memo: `Salary ${m} - ${e.name}` });
      });
      ctx.ensureCOA();
      ctx.postPayrollJournal(m, total);
      S.save();
      return { month: m, employees: active.length, total };
    },
  },

  'purchase-save': {
    view: 'purchases',
    run(ctx, p) {
      const raw = p.out || {};
      need(['draft', 'ordered', 'received'].includes(raw.status), 'bad status');
      const S = ctx.store;
      validItems(raw.items, S);
      need(raw.supplier_id == null || raw.supplier_id === '' || S.data.suppliers.some(x => x.id === Number(raw.supplier_id)), 'supplier not found');
      /* only these client fields are ever read: number, posting flags and
         received_date are server-owned and cannot be forged on an edit */
      const items = raw.items.map(it => ({ product_id: it.product_id == null ? null : Number(it.product_id), description: it.description, qty: Number(it.qty), cost: Number(it.cost != null ? it.cost : it.price) }));
      const fields = { status: raw.status, supplier_id: raw.supplier_id ? Number(raw.supplier_id) : null, order_date: raw.order_date, notes: String(raw.notes || ''), items };
      let rec = null;
      if (p.id != null) {
        rec = S.data.purchases.find(x => x.id === Number(p.id));
        need(rec, 'purchase not found');
        if ((rec.receipts || []).some(r => !r.void) && rec.status !== 'received') {
          /* partially received: goods and payables are already posted for part of it. Only the note can change;
             the rest is received through purchase-receive so every receipt stays on the record. */
          const sameLines = fields.status === 'ordered' && fields.supplier_id === (rec.supplier_id || null)
            && fields.items.length === rec.items.length
            && fields.items.every((it, i) => it.product_id === (rec.items[i].product_id == null ? null : Number(rec.items[i].product_id))
              && Math.abs(it.qty - Number(rec.items[i].qty)) < 1e-9 && Math.abs(it.cost - Number(rec.items[i].cost)) < 1e-9);
          need(sameLines, 'this purchase is partly received: its lines cannot be changed or marked received here. Receive the remaining quantities with "Receive goods".');
          rec.notes = fields.notes;
        } else if (rec.status === 'received' || rec.stock_applied || rec.journal_received) {
          /* a received purchase is accounting history: only the note may change */
          const same = fields.status === 'received' && fields.supplier_id === (rec.supplier_id || null)
            && fields.items.length === rec.items.length
            && fields.items.every((it, i) => it.product_id === (rec.items[i].product_id == null ? null : Number(rec.items[i].product_id))
              && Math.abs(it.qty - Number(rec.items[i].qty)) < 1e-9 && Math.abs(it.cost - Number(rec.items[i].cost != null ? rec.items[i].cost : rec.items[i].price)) < 1e-9);
          need(same, 'a received purchase cannot be changed or moved back: it is posted to stock and payables');
          rec.notes = fields.notes;
        } else {
          Object.assign(rec, fields);
        }
      } else {
        rec = S.add('purchases', Object.assign(fields, {
          number: `PO-${String(S.data.meta.purchaseSeq).padStart(4, '0')}`, stock_applied: false, ledger_posted: false,
        }));
        S.data.meta.purchaseSeq++;
      }
      /* the same receive side effects the form applies */
      if (rec.status === 'received' && !rec.stock_applied) {
        ctx.applyStock(rec.items.map(it => ({ product_id: it.product_id, qty: it.qty })), +1, { reason: 'purchase', ref_type: 'purchase', ref_id: rec.id });
        rec.stock_applied = true;
        rec.received_date = ctx.todayStr();
      }
      if (rec.status === 'received' && !rec.journal_received) {
        ctx.ensureCOA();
        if (ctx.postPurchaseReceivedJournal(rec)) rec.journal_received = true;
      }
      if (rec.status === 'received' && !rec.ledger_posted) {
        S.add('ledger', { date: ctx.todayStr(), type: 'expense', category: 'Purchases', amount: Math.round(ctx.purchaseTotal(rec) * 100) / 100, ref_type: 'purchase', ref_id: rec.id, memo: `${rec.number} received` });
        rec.ledger_posted = true;
      }
      S.save();
      return { purchase: rec };
    },
  },

  /* Partial receipt: receive part of an ordered purchase. Each receipt moves stock in and posts
     Dr Inventory / Cr Payables for exactly the received quantities at the PO line cost. The last
     receipt of a line takes only that line's own cent remainder (no value moves between lines); nothing else is
     adjusted. Supplier payment and return to supplier stay blocked until the purchase is fully
     received (they only work on a fully received purchase). Product lines only. */
  'purchase-receive': {
    view: 'purchases',
    run(ctx, p, user) {
      const S = ctx.store, r2 = v => Math.round(v * 100) / 100;
      const po = S.data.purchases.find(x => x.id === Number(p.id));
      need(po, 'purchase not found');
      po.receipts = po.receipts || [];
      const ref = p.client_ref ? String(p.client_ref).slice(0, 80) : '';
      if (ref) {
        const dup = po.receipts.find(r => r.client_ref === ref);
        if (dup) return { purchase: po, receipt: dup, deduped: true };
      }
      need(po.status === 'ordered' && !po.journal_received && !po.stock_applied, 'only an ordered purchase can be received; a received one is already posted');
      need(po.items.length > 0 && po.items.every(it => it.product_id != null), 'partial receipt needs every line to be a stock product; mark the purchase received instead');
      need(Array.isArray(p.items) && p.items.length >= 1 && p.items.length <= 500, 'choose the quantities received');
      const seen = new Set(), recv = [];
      for (const l of p.items) {
        need(l && typeof l === 'object', 'bad receipt line');
        const i = Number(l.line), q = Number(l.qty);
        need(Number.isInteger(i) && i >= 0 && i < po.items.length, 'unknown purchase line');
        need(!seen.has(i), 'duplicate line in the receipt');
        seen.add(i);
        need(Number.isFinite(q) && q > 0 && q <= 1e9, 'received quantity must be positive');
        const it = po.items[i], left = ctx.num(it.qty) - ctx.num(it.received_qty);
        need(q <= left + 1e-9, `cannot receive more than ordered: ${left} left on line ${i + 1}`);
        recv.push({ line: i, product_id: Number(it.product_id), qty: q, cost: ctx.num(it.cost) });
      }
      /* purchases carry no discount or tax lines; each line's value is its own qty x cost rounded to the cent.
         Receipts allocate each line's OWN value pro rata by quantity, and a line's last receipt takes only
         that line's own cent remainder, so no value ever moves between lines. If the line values cannot add
         up to the PO total (sub-cent costs), partial receipt is refused. */
      const lineVal = po.items.map(it => r2(ctx.num(it.qty) * ctx.num(it.cost)));
      need(Math.abs(lineVal.reduce((a, v) => a + v, 0) - r2(ctx.purchaseTotal(po))) < 0.005, 'this purchase has costs with fractions of a cent, so its lines cannot be split into receipts exactly; mark it received in one step');
      const complete = po.items.every((it, i) => {
        const r = recv.find(x => x.line === i);
        return Math.abs(ctx.num(it.qty) - ctx.num(it.received_qty) - (r ? r.qty : 0)) < 1e-9;
      });
      for (const r of recv) {
        const it = po.items[r.line];
        const prev = r2(po.receipts.filter(rc => !rc.void).reduce((a, rc) => a + ((rc.items || []).filter(x => x.line === r.line).reduce((b, x) => b + (x.amount != null ? ctx.num(x.amount) : r2(x.qty * ctx.num(it.cost))), 0)), 0));
        const cum = ctx.num(it.received_qty) + r.qty;
        r.amount = r2((cum >= ctx.num(it.qty) - 1e-9 ? lineVal[r.line] : r2(lineVal[r.line] * cum / ctx.num(it.qty))) - prev);
      }
      const amount = r2(recv.reduce((a, r) => a + r.amount, 0));
      need(amount > 0, 'the received value is zero (check the line costs)');
      ctx.ensureCOA();
      ctx.applyStock(recv.map(r => ({ product_id: r.product_id, qty: r.qty })), +1, { reason: 'purchase-receipt', ref_type: 'purchase', ref_id: po.id });
      const je = ctx.postJournal({ date: ctx.todayStr(), memo: `${po.number} receipt ${po.receipts.length + 1}`, ref_type: 'purchase', ref_id: po.id,
        lines: [{ account_id: ctx.accountByCode('1200').id, debit: amount }, { account_id: ctx.accountByCode('2000').id, credit: amount }] });
      need(je, 'receipt could not be posted');
      S.add('ledger', { date: ctx.todayStr(), type: 'expense', category: 'Purchases', amount, ref_type: 'purchase', ref_id: po.id, memo: `${po.number} receipt ${po.receipts.length + 1}` });
      for (const r of recv) po.items[r.line].received_qty = ctx.num(po.items[r.line].received_qty) + r.qty;
      const rec = { n: po.receipts.length + 1, date: ctx.todayStr(), by: user.username, items: recv.map(r => ({ line: r.line, qty: r.qty, amount: r.amount })), amount, journal_id: je.id, client_ref: ref || null };
      po.receipts.push(rec);
      if (complete) {
        po.status = 'received'; po.stock_applied = true; po.journal_received = true; po.ledger_posted = true; po.received_date = ctx.todayStr();
      }
      S.save();
      return { purchase: po, receipt: rec, complete };
    },
  },

  /* Void the LATEST active receipt of a still-partly-received purchase. Admin only, reason required.
     The receipt stays on the record (void with who/when/why); its journal is reversed at the original
     amount, the goods leave stock only if still on hand, and the received quantities are freed. A fully
     received purchase is accounting history and is corrected by a supplier return instead. */
  'purchase-receipt-void': {
    view: 'purchases',
    run(ctx, p, user) {
      need(user && user.role === 'admin', 'only an admin can void a receipt');
      const S = ctx.store, r2 = v => Math.round(v * 100) / 100;
      const po = S.data.purchases.find(x => x.id === Number(p.id));
      need(po, 'purchase not found');
      need(po.status === 'ordered' && !po.journal_received, 'only a partly received purchase can have a receipt voided; a fully received one is corrected with a supplier return');
      need(String(p.reason || '').trim().length >= 5, 'a void reason of at least 5 characters is required');
      const active = (po.receipts || []).filter(r => !r.void);
      need(active.length > 0, 'there is no active receipt to void');
      const rc = active[active.length - 1];
      need(Number(p.n) === rc.n, 'only the latest active receipt can be voided (receipt ' + rc.n + ')');
      const j = S.data.journal.find(x => x.id === rc.journal_id);
      need(j && j.ref_type === 'purchase' && j.ref_id === po.id, 'the receipt posting was not found; review it manually');
      for (const it of rc.items) {
        const li = po.items[it.line], pr = S.data.products.find(x => x.id === Number(li.product_id));
        need(pr && ctx.num(pr.stock) >= it.qty, `cannot void: the ${it.qty} unit(s) of ${pr ? pr.name : li.product_id} received are no longer on hand`);
      }
      need(ctx.postJournal({ date: ctx.todayStr(), memo: `Void of ${po.number} receipt ${rc.n}: ${String(p.reason).trim()}`, ref_type: 'purchase-receipt-void', ref_id: po.id,
        lines: j.lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })) }), 'reversal could not be posted');
      ctx.applyStock(rc.items.map(it => ({ product_id: Number(po.items[it.line].product_id), qty: it.qty })), -1, { reason: 'purchase-receipt-void', ref_type: 'purchase', ref_id: po.id });
      S.add('ledger', { date: ctx.todayStr(), type: 'income', category: 'Purchase receipt void', amount: r2(rc.amount), ref_type: 'purchase', ref_id: po.id, memo: `${po.number} receipt ${rc.n} voided` });
      for (const it of rc.items) po.items[it.line].received_qty = Math.max(0, ctx.num(po.items[it.line].received_qty) - it.qty);
      Object.assign(rc, { void: true, void_reason: String(p.reason).trim(), voided_by: user.username, voided_at: new Date().toISOString() });
      S.save();
      return { purchase: po, receipt: rc };
    },
  },

  'purchase-delete': {
    view: 'purchases',
    run(ctx, p) {
      const S = ctx.store;
      const po = S.data.purchases.find(x => x.id === Number(p.id));
      need(po, 'purchase not found');
      need(po.status !== 'received' && !po.journal_received && !(po.receipts || []).some(r => !r.void), 'received or partly received purchases are accounting history; they cannot be deleted');
      if (po.stock_applied) ctx.applyStock(po.items.map(it => ({ product_id: it.product_id, qty: it.qty })), -1, { reason: 'purchase-delete', ref_type: 'purchase', ref_id: po.id });
      S.remove('purchases', po.id);
      return { deleted: po.id };
    },
  },

  'product-save': {
    view: 'products',
    run(ctx, p) {
      /* bom is written only by bom-save (validated, single-level) */
      const out = pick(p.out, ['name', 'sku', 'category', 'reorder_level', 'price', 'cost', 'stock']);
      need(String(out.name || '').trim(), 'name required');
      need(ctx.num(out.price) >= 0 && ctx.num(out.cost) >= 0, 'prices must not be negative');
      const S = ctx.store;
      let prod;
      if (p.id != null) {
        prod = S.data.products.find(x => x.id === Number(p.id));
        need(prod, 'product not found');
        const stock = prod.stock;            // stock is server-owned
        need(!(ctx.num(stock) > 0 && Math.abs(ctx.num(out.cost) - ctx.num(prod.cost)) > 1e-9),
          `The cost cannot be changed while ${stock} unit(s) are in stock: the books value that stock at the old cost, so a silent change would make inventory disagree with accounting. Revaluation of stock on hand is not supported yet. Change the cost when stock is zero; record damaged or lost stock with a stock adjustment.`);
        Object.assign(prod, out);
        prod.stock = stock;
        S.save();
      } else {
        const stock = ctx.num(out.stock);
        prod = S.add('products', { ...out, stock: 0 });
        if (stock) {
          ctx.recordStockMove({ product_id: prod.id, qty: stock, reason: 'opening', memo: ctx.t('Opening balance') });
          ctx.postOpeningStockJournal(prod, stock);   // Dr Inventory / Cr equity
        }
        S.save();
      }
      return { product: prod };
    },
  },

  /* Reviewed revaluation of stock on hand. Admin only. The reviewer must
     send the exact adjustment amount they were shown (expected_value); a
     mismatch means the stock or cost moved since the review and nothing
     is posted. Gain/loss goes to Cost of goods sold, in its own entry. */
  /* Stock revaluation / write-down is NOT supported yet. Overwriting the unit cost would lose the
     acquisition cost that returns, COGS and production depend on, and the model has no valuation
     allowance to carry the difference. The route stays registered so it is visible in the inventory
     and fails with a clear message instead of a silent cost edit. */
  'product-revalue': {
    view: 'products',
    run() {
      need(false, 'Stock revaluation and write-downs are not supported yet: changing the cost of stock on hand would lose the original purchase cost that returns, COGS and production rely on. Record damaged or lost stock with a stock adjustment (reason required) instead.');
    },
  },

  'product-delete': {
    view: 'products',
    run(ctx, p) {
      const S = ctx.store;
      const prod = S.data.products.find(x => x.id === Number(p.id));
      need(prod, 'product not found');
      need(Math.abs(ctx.num(prod.stock)) < 0.0005, 'product still has stock; adjust to zero first');
      S.remove('products', prod.id);
      return { deleted: prod.id };
    },
  },

  /* ---------------- sales orders & returns ---------------- */

  'order-save': {
    view: 'orders',
    run(ctx, p) {
      const out = pick(p.out, ['status', 'contact_id', 'order_date', 'tax_rate', 'notes', 'items']);
      need(['draft', 'confirmed'].includes(out.status), 'bad status');
      const S = ctx.store;
      validItems(out.items, S);
      need(ctx.num(out.tax_rate) >= 0 && ctx.num(out.tax_rate) <= 100, 'bad tax rate');
      let o;
      if (p.id != null) {
        o = S.data.sales_orders.find(x => x.id === Number(p.id));
        need(o, 'order not found');
        need(o.status === 'draft', 'only draft orders can be edited');
        Object.assign(o, out);
        S.save();
      } else {
        S.data.meta.orderSeq = S.data.meta.orderSeq || 1;
        out.number = `SO-${String(S.data.meta.orderSeq).padStart(4, '0')}`;
        S.data.meta.orderSeq++;
        out.invoice_id = null;
        out.quote_id = out.quote_id || null;
        o = S.add('sales_orders', out);
      }
      return { order: o };
    },
  },

  'quote-to-order': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const q = S.data.quotes.find(x => x.id === Number(p.id));
      need(q, 'quote not found');
      need(!q.order_id, 'quote already converted to an order');
      S.data.meta.orderSeq = S.data.meta.orderSeq || 1;
      const o = S.add('sales_orders', {
        number: `SO-${String(S.data.meta.orderSeq++).padStart(4, '0')}`,
        status: 'draft', contact_id: q.contact_id, order_date: ctx.todayStr(),
        tax_rate: ctx.num(q.tax_rate),
        notes: `${ctx.t('From quote')} ${q.number}${q.notes ? ' — ' + q.notes : ''}`,
        items: (q.items || []).map(it => ({ product_id: it.product_id || null, description: it.description || '', qty: ctx.num(it.qty), price: ctx.num(it.price) })),
        quote_id: q.id, invoice_id: null,
      });
      q.order_id = o.id;
      S.save();
      return { order: o };
    },
  },

  'order-confirm': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'draft', 'only a draft order can be confirmed');
      o.status = 'confirmed';
      S.save();
      return { order: o };
    },
  },

  /* Fulfillment creates the real invoice through saveInvoice, so stock,
     COGS and revenue journals all post under the invoice's own rules.
     Idempotent: an order with invoice_id can never be fulfilled twice —
     the write queue serializes any concurrent attempts. */
  'order-fulfill': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'confirmed', 'only a confirmed order can be fulfilled');
      need(!o.invoice_id, 'order already fulfilled');
      for (const it of o.items) {
        const prod = it.product_id != null ? S.data.products.find(x => x.id === Number(it.product_id)) : null;
        if (prod) need(ctx.num(prod.stock) >= ctx.num(it.qty), `insufficient stock for ${prod.name}`);
      }
      ctx.saveInvoice(null, {
        status: 'sent', contact_id: o.contact_id,
        issue_date: ctx.todayStr(), due_date: ctx.todayStr(),
        tax_rate: ctx.num(o.tax_rate),
        notes: `${ctx.t('From order')} ${o.number}${o.notes ? ' — ' + o.notes : ''}`,
        items: (o.items || []).map(it => ({ product_id: it.product_id || null, description: it.description || '', qty: ctx.num(it.qty), price: ctx.num(it.price) })),
        order_id: o.id,
      });
      const created = S.data.invoices[S.data.invoices.length - 1];
      o.status = 'fulfilled';
      o.invoice_id = created ? created.id : null;
      o.fulfilled_date = ctx.todayStr();
      S.save();
      return { order: o, invoice_id: o.invoice_id };
    },
  },

  'order-cancel': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'draft' || o.status === 'confirmed', 'fulfilled orders need a return, not a cancellation');
      o.status = 'cancelled';
      S.save();
      return { order: o };
    },
  },

  'order-delete': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'draft', 'only draft orders can be deleted');
      S.remove('sales_orders', o.id);
      return { deleted: o.id };
    },
  },

  /* Upgrade migration: one clearly-labelled equity-offset entry aligns the
     Inventory GL with the stock ledger for data created before inventory
     postings existed. Idempotent; the invariant gate verifies the result. */
  'migrate-inventory': {
    view: 'accounting',
    run(ctx, p, user) {
      /* an equity-offset adjustment is an accounting decision: it posts only
         on explicit approval by an authorized admin, never automatically */
      need(user && user.role === 'admin', 'only an admin can approve the inventory adjustment');
      ctx.ensureCOA();
      ctx.ensureStockBaseline();
      const gap = ctx.inventoryGap();
      if (Math.abs(gap) <= 0.01) return { posted: false, gap: 0 };
      const invAcc = ctx.accountByCode('1200'), eq = ctx.accountByCode('3000');
      const lines = gap > 0
        ? [{ account_id: invAcc.id, debit: gap }, { account_id: eq.id, credit: gap }]
        : [{ account_id: eq.id, debit: -gap }, { account_id: invAcc.id, credit: -gap }];
      const entry = ctx.postJournal({
        date: ctx.todayStr(),
        memo: ctx.t('Migration: align inventory valuation with the stock ledger (pre-upgrade data)'),
        ref_type: 'migration', ref_id: null, lines,
      });
      need(entry, 'migration journal failed');
      return { posted: true, gap };
    },
  },

  'reclass-settlement': {
    view: 'accounting',
    run(ctx, p, user) {
      /* legacy settlement misclassification is an accounting decision: a
         dated reclass posts only on explicit admin approval, one entry per
         payment, original entries untouched. Payments already refunded out
         of the cash account are excluded — their money is already gone. */
      need(user && user.role === 'admin', 'only an admin can approve a settlement reclass');
      ctx.ensureCOA();
      const cash = ctx.accountByCode('1000'), bank = ctx.accountByCode('1010');
      const S = ctx.store;
      const refunded = new Set((S.data.payments || []).filter(o => o.direction === 'out').map(o => o.ref_type + ':' + o.ref_id));
      const rows = (S.data.payments || []).filter(pay =>
        pay.direction === 'in' && !pay.reclassed && !refunded.has(pay.ref_type + ':' + pay.ref_id) &&
        ['bank', 'transfer', 'card'].includes(pay.method) && pay.journal_id &&
        (((S.data.journal || []).find(j => j.id === pay.journal_id) || {}).lines || [])
          .some(l => ctx.num(l.debit) > 0 && l.account_id === cash.id));
      let targets;
      if (Array.isArray(p.ids)) targets = rows.filter(pay => p.ids.map(Number).includes(pay.id));
      else if (p.all) targets = rows;
      else targets = rows.filter(pay => pay.id === Number(p.id));
      need(targets.length, 'no matching legacy settlement to reclass');
      let posted = 0, total = 0;
      for (const pay of targets) {
        const amt = Math.round(ctx.num(pay.amount) * 100) / 100;
        const e = ctx.postJournal({
          date: ctx.todayStr(),
          memo: `${ctx.t('Reclass: legacy settlement posted to cash, actual method')} ${ctx.t(pay.method)} (${pay.memo || '#' + pay.id})`,
          ref_type: 'reclass', ref_id: pay.id,
          lines: [{ account_id: bank.id, debit: amt }, { account_id: cash.id, credit: amt }],
        });
        need(e, 'reclass journal failed');
        pay.reclassed = true;
        posted++; total += amt;
      }
      return { posted, total: Math.round(total * 100) / 100 };
    },
  },

  /* Manufacturing: a BOM is the component recipe stored on the finished
     product. Products are server-owned, so the recipe changes only here.
     Scope: single-level recipes (direct components only, no explosion).
     Recipe shapes we do not support are rejected, never half-applied:
     duplicate components and direct/indirect cycles. */
  'bom-save': {
    view: 'manufacturing',
    run(ctx, p) {
      const S = ctx.store;
      const prod = S.data.products.find(x => x.id === Number(p.product_id));
      need(prod, 'product not found');
      const bom = [];
      for (const l of (Array.isArray(p.lines) ? p.lines : [])) {
        const cid = Number(l.product_id), q = ctx.num(l.qty);
        if (!cid) continue;
        need(cid !== prod.id, 'a product cannot be its own component');
        need(S.data.products.some(x => x.id === cid), 'component product not found');
        need(q > 0 && q <= 1e9, 'component quantity must be positive');
        need(!bom.some(x => x.product_id === cid), 'duplicate component — combine the quantities into one line');
        const compProd = S.data.products.find(x => x.id === cid);
        need(!(compProd && Array.isArray(compProd.bom) && compProd.bom.length), `multi-level recipes are not supported — ${compProd ? compProd.name : cid} has its own bill of materials`);
        bom.push({ product_id: cid, qty: q });
      }
      /* indirect cycle: no component may reach this product through its
         own BOM (A needs B, B needs A), directly or transitively */
      const reaches = (fromId, targetId, seen) => {
        if (fromId === targetId) return true;
        if (seen.has(fromId)) return false;
        seen.add(fromId);
        const f = S.data.products.find(x => x.id === fromId);
        return (f && Array.isArray(f.bom) ? f.bom : []).some(l => reaches(l.product_id, targetId, seen));
      };
      for (const l of bom) need(!reaches(l.product_id, prod.id, new Set()), 'circular recipe — a component already contains this product in its own bill of materials');
      /* single-level only, both ways: a product that is already a component elsewhere cannot get its own recipe */
      need(!bom.length || !S.data.products.some(x => x.id !== prod.id && Array.isArray(x.bom) && x.bom.some(l => l.product_id === prod.id)), `multi-level recipes are not supported: ${prod.name} is already a component of another product`);
      prod.bom = bom;
      S.save();
      return { product_id: prod.id, bom };
    },
  },

  /* Production run: validates component availability, consumes components
     and outputs finished goods as stock moves, and posts Dr Inventory
     (finished at product cost) / Cr Inventory (components at their cost).
     The net inside 1200 exactly matches the stock-valuation change, so the
     GL-vs-ledger invariant holds with no variance account and no
     fabrication: finished goods carry the product's stated cost. */
  'produce': {
    view: 'manufacturing',
    run(ctx, p) {
      const S = ctx.store;
      /* exactly-once: a retried/duplicated submit carrying the same
         client_ref returns the original run instead of double-producing
         (same pattern as POS sales) */
      if (p.client_ref) {
        const dup = (S.data.production || []).find(r => r.client_ref === p.client_ref);
        if (dup) return { production: dup, deduped: true };
      }
      const prod = S.data.products.find(x => x.id === Number(p.product_id));
      need(prod, 'product not found');
      const qty = ctx.num(p.qty);
      need(qty > 0 && qty <= 1e9, 'quantity must be positive');
      need(Array.isArray(prod.bom) && prod.bom.length, 'product has no bill of materials');
      for (const l of prod.bom) {
        const comp = S.data.products.find(x => x.id === l.product_id);
        need(comp, 'component product not found');
        need(ctx.num(comp.stock) + 1e-9 >= ctx.num(l.qty) * qty, `${ctx.t('Insufficient stock for')} ${comp.name}`);
      }
      const rec = S.add('production', { date: ctx.todayStr(), product_id: prod.id, qty, status: 'done', client_ref: p.client_ref || null });
      let compCost = 0;
      for (const l of prod.bom) {
        const comp = S.data.products.find(x => x.id === l.product_id);
        compCost += ctx.num(comp.cost) * ctx.num(l.qty) * qty;
        ctx.recordStockMove({ product_id: comp.id, qty: -ctx.num(l.qty) * qty, reason: 'production-consume', ref_type: 'production', ref_id: rec.id, memo: prod.name });
      }
      ctx.recordStockMove({ product_id: prod.id, qty, reason: 'production-output', ref_type: 'production', ref_id: rec.id, memo: prod.name });
      compCost = Math.round(compCost * 100) / 100;
      const outVal = Math.round(ctx.num(prod.cost) * qty * 100) / 100;
      const invAcc = ctx.accountByCode('1200'), varAcc = ctx.accountByCode('5200');
      /* balanced entry in all cost configurations: finished goods in at
         product cost, components out at their cost, the difference to
         Manufacturing Variance (debit unfavorable, credit favorable) */
      const lines = [];
      if (outVal > 0) lines.push({ account_id: invAcc.id, debit: outVal });
      if (compCost > 0) lines.push({ account_id: invAcc.id, credit: compCost });
      const diff = Math.round((outVal - compCost) * 100) / 100;
      if (diff > 0) lines.push({ account_id: varAcc.id, credit: diff });
      else if (diff < 0) lines.push({ account_id: varAcc.id, debit: -diff });
      if (lines.length >= 2) {
        const e = ctx.postJournal({ date: ctx.todayStr(), memo: `${ctx.t('Production')}: ${prod.name} × ${qty}`, ref_type: 'production', ref_id: rec.id, lines });
        need(e, 'production journal failed');
      }
      S.save();
      return { production: rec, component_cost: compCost, output_value: outVal, variance: -diff };
    },
  },

  /* Return: validates quantities against what was sold minus what was
     already returned, then posts stock-in, revenue+VAT reversal, COGS
     reversal and the money side — atomically. */
  'recurring-save': {
    view: 'invoices',
    run(ctx, p) {
      const out = pick(p.out, ['status', 'contact_id', 'interval', 'next_date', 'end_date', 'tax_rate', 'notes', 'items', 'auto_post', 'anchor_day']);
      const S = ctx.store;
      need(['weekly', 'monthly', 'quarterly', 'yearly'].includes(out.interval), 'bad interval');
      need(out.contact_id && S.data.contacts.some(c => c.id === Number(out.contact_id)), 'customer required');
      out.contact_id = Number(out.contact_id);
      validItems(out.items, S);
      need(/^\d{4}-\d{2}-\d{2}$/.test(out.next_date || ''), 'start date required');
      need(!out.end_date || /^\d{4}-\d{2}-\d{2}$/.test(out.end_date), 'bad end date');
      need(ctx.num(out.tax_rate) >= 0 && ctx.num(out.tax_rate) <= 100, 'bad tax rate');
      out.auto_post = !!out.auto_post;
      /* the anchor day keeps month-end schedules on their intended day
         (Jan 31 -> Feb 28/29 -> Mar 31) instead of drifting */
      out.anchor_day = Number(String(out.next_date).slice(8, 10));
      let r;
      if (p.id != null) {
        r = S.data.recurring.find(x => x.id === Number(p.id));
        need(r, 'recurring template not found');
        const status = r.status;
        Object.assign(r, out);
        /* status moves only through recurring-status / completion */
        if (!['active', 'paused', 'completed'].includes(r.status)) r.status = status;
        S.save();
      } else {
        r = S.add('recurring', { ...out, status: out.status === 'paused' ? 'paused' : 'active', last_invoice_id: null });
      }
      return { template: r };
    },
  },
  'recurring-status': {
    view: 'invoices',
    run(ctx, p) {
      const r = ctx.store.data.recurring.find(x => x.id === Number(p.id));
      need(r, 'recurring template not found');
      need(['active', 'paused'].includes(p.status), 'bad status');
      need(r.status !== 'completed', 'completed templates cannot change status');
      r.status = p.status;
      return { template: r };
    },
  },
  'recurring-delete': {
    view: 'invoices',
    run(ctx, p) {
      const S = ctx.store;
      const r = S.data.recurring.find(x => x.id === Number(p.id));
      need(r, 'recurring template not found');
      S.data.recurring = S.data.recurring.filter(x => x.id !== r.id);
      return { deleted: r.id };
    },
  },
  'recurring-run': {
    view: 'invoices',
    run(ctx, p) {
      const S = ctx.store;
      /* the run date is the server's date: a client may only name an EARLIER date (a dry catch-up
         window), never a future one that would generate and post invoices early */
      const today = validDate(p.today) && (FUTURE_OK || p.today <= ctx.todayStr()) ? p.today : ctx.todayStr();
      const made = [], blocked = [];
      /* explicit user-triggered run only — never fired by opening a view.
         Templates generate DRAFT invoices unless the template opts in to
         auto-posting (auto_post), which posts stock and accounting. */
      const list = p.id != null
        ? S.data.recurring.filter(x => x.id === Number(p.id))
        : S.data.recurring;
      need(p.id == null || list.length === 1, 'recurring template not found');
      for (const r of list) {
        let guard = 0;
        /* one invoice per elapsed period; advancing next_date per period
           makes a re-run idempotent, and a cap keeps a long-offline server
           from flooding the books */
        while (r.status === 'active' && r.next_date && r.next_date <= today && guard++ < 24) {
          if (r.auto_post) {
            const lacking = (r.items || []).map(it => {
              if (it.product_id == null) return null;
              const prod = S.data.products.find(x => x.id === Number(it.product_id));
              return prod && ctx.num(prod.stock) < ctx.num(it.qty) ? prod : null;
            }).find(x => x);
            if (lacking) { blocked.push(`${lacking.name} (${r.next_date})`); break; }
          }
          ctx.saveInvoice(null, {
            status: r.auto_post ? 'sent' : 'draft', contact_id: r.contact_id, deal_id: null,
            issue_date: r.next_date, due_date: r.next_date,
            tax_rate: r.tax_rate || 0, notes: r.notes || '',
            items: r.items.map(it => ({ ...it })),
            recurring_id: r.id,
          });
          const inv = S.data.invoices[S.data.invoices.length - 1];
          r.last_invoice_id = inv.id;
          made.push(inv.number);
          r.next_date = ctx.advanceDate(r.next_date, r.interval, r.anchor_day);
          if (r.end_date && r.next_date > r.end_date) r.status = 'completed';
        }
      }
      return { created: made, blocked };
    },
  },
  /* ---------------- corrections: sales credit notes, purchase returns ----------------
     A posted invoice or received purchase is never edited. A mistake is
     corrected by a separate, explicit, numbered document that posts its own
     reversing journal and (when asked) the matching stock move. Money that
     must go back (customer refund / supplier refund) is only recorded when
     the reviewer names the refund method; nothing is plugged. */
  'credit-note-create': {
    view: 'invoices',
    run(ctx, p, user) {
      const S = ctx.store;
      const r2 = v => Math.round(v * 100) / 100;
      S.data.credit_notes = S.data.credit_notes || [];
      if (p.client_ref) {
        const dup = S.data.credit_notes.find(x => x.client_ref === String(p.client_ref));
        if (dup) return { credit_note: dup, duplicate: true };
      }
      const inv = S.data.invoices.find(i => i.id === Number(p.invoice_id));
      need(inv, 'invoice not found');
      need(['sent', 'paid'].includes(inv.status) && inv.journal_sent, 'only a posted (sent or paid) invoice can be credited; edit or delete a draft instead, and a refunded POS sale is already fully reversed');
      need(String(p.reason || '').trim().length >= 3, 'a reason is required');
      need(Array.isArray(p.items) && p.items.length > 0, 'choose at least one invoice line to credit');
      const prior = {};
      for (const cn of S.data.credit_notes.filter(x => x.invoice_id === inv.id && x.status !== 'void')) {
        for (const it of cn.items) prior[it.line] = (prior[it.line] || 0) + it.qty;
      }
      const seen = new Set(), items = [];
      for (const raw of p.items) {
        const line = Number(raw.line);
        need(Number.isInteger(line) && line >= 0 && line < inv.items.length, 'unknown invoice line');
        need(!seen.has(line), 'duplicate invoice line');
        seen.add(line);
        const qty = Number(raw.qty);
        need(Number.isFinite(qty) && qty > 0, 'credit quantity must be positive');
        const src = inv.items[line];
        need(qty <= Number(src.qty) - (prior[line] || 0) + 1e-9, `credit quantity exceeds what is left to credit on line ${line + 1}`);
        items.push({ line, product_id: src.product_id == null ? null : src.product_id, description: src.description || '', qty, price: Number(src.price), restock: !!raw.restock && src.product_id != null && !!inv.stock_applied });
      }
      const perProd = {};
      for (const it of items) { const k = it.product_id == null ? 'null' : it.product_id; perProd[k] = (perProd[k] || 0) + it.qty; }
      for (const k of Object.keys(perProd)) {
        const pid = k === 'null' ? null : Number(k);
        need(perProd[k] + creditedProductQty(S, inv, pid) <= invoicedProductQty(inv, pid) + 1e-9, 'this product has already been credited or returned (credit notes and sales-order returns together) up to the invoiced quantity');
      }
      const sub = r2(items.reduce((s, it) => s + it.qty * it.price, 0));
      const tax = r2(sub * ctx.num(inv.tax_rate) / 100);
      const total = r2(sub + tax);
      need(total > 0, 'credit total must be positive');
      const open = ctx.invoiceOpenAmount(inv);
      const toAR = Math.min(total, open);
      const excess = r2(total - toAR);
      let method = null, refundRef = null, refundBy = null;
      if (excess > 0.005) { const c = confirmedRefund(ctx, p, excess, user, 'customer'); method = c.method; refundRef = c.reference; refundBy = c.by; }
      ctx.ensureCOA();
      const date = ctx.todayStr();
      const number = `CN-${String(S.data.meta.cnSeq++).padStart(4, '0')}`;
      const cn = S.add('credit_notes', { number, invoice_id: inv.id, invoice_number: inv.number, contact_id: inv.contact_id || null, date, reason: String(p.reason).trim(),
        items, subtotal: sub, tax, total, applied_to_receivable: toAR, refunded: excess, refund_method: method, refund_reference: refundRef, refund_confirmed_by: refundBy, status: 'posted', client_ref: p.client_ref ? String(p.client_ref) : null });
      const lines = [{ account_id: ctx.accountByCode('4000').id, debit: sub }];
      if (tax > 0) lines.push({ account_id: ctx.accountByCode('2100').id, debit: tax });
      if (toAR > 0.005) lines.push({ account_id: ctx.accountByCode('1100').id, credit: toAR });
      if (excess > 0.005) lines.push({ account_id: ctx.settlementAccountId(method), credit: excess });
      need(ctx.postJournal({ date, memo: `Credit note ${number} (${inv.number})`, ref_type: 'credit_note', ref_id: cn.id, lines }), 'credit note could not be posted');
      const back = items.filter(it => it.restock);
      if (back.length) {
        ctx.applyStock(back.map(it => ({ product_id: it.product_id, qty: it.qty })), +1, { reason: 'credit-note', ref_type: 'credit_note', ref_id: cn.id });
        const cogs = r2(back.reduce((s, it) => { const pr = S.data.products.find(x => x.id === it.product_id); return s + (pr ? it.qty * ctx.num(pr.cost) : 0); }, 0));
        if (cogs > 0) need(ctx.postJournal({ date, memo: `COGS reversal for ${number}`, ref_type: 'credit_note-cogs', ref_id: cn.id,
          lines: [{ account_id: ctx.accountByCode('1200').id, debit: cogs }, { account_id: ctx.accountByCode('5000').id, credit: cogs }] }), 'cost reversal could not be posted');
      }
      if (excess > 0.005) S.add('ledger', { date, type: 'expense', category: 'Sales return', amount: excess, ref_type: 'credit_note', ref_id: cn.id, memo: `Refund for ${number}` });
      inv.credited_amount = r2(ctx.num(inv.credited_amount) + total);
      S.save();
      return { credit_note: cn };
    },
  },

  /* Void a posted credit note or purchase return. The original stays on the record (status 'void'
     with who, when and why); its journal is reversed line by line at the ORIGINAL amounts, and its
     stock effect is undone only when the goods can actually be taken back. A document that moved
     money (a confirmed refund) cannot be voided here: that would need the money recorded coming
     back, which is not supported, so it is rejected. Admin only. */
  'credit-note-void': {
    view: 'invoices',
    run(ctx, p, user) {
      need(user && user.role === 'admin', 'only an admin can void a credit note');
      const S = ctx.store, r2 = v => Math.round(v * 100) / 100;
      const cn = (S.data.credit_notes || []).find(x => x.id === Number(p.id));
      need(cn, 'credit note not found');
      need(cn.status === 'posted', 'this credit note is not active (already void)');
      need(String(p.reason || '').trim().length >= 5, 'a void reason of at least 5 characters is required');
      need(ctx.num(cn.refunded) < 0.005, 'this credit note included a confirmed refund of money; voiding it would need that money recorded as returned, which is not supported yet');
      const inv = S.data.invoices.find(i => i.id === cn.invoice_id);
      need(inv && ['sent', 'paid'].includes(inv.status) && inv.journal_sent, 'the invoice is no longer in a state that can take this credit note back');
      const back = (cn.items || []).filter(it => it.restock && it.product_id != null);
      const need2 = {};
      for (const it of back) need2[it.product_id] = (need2[it.product_id] || 0) + ctx.num(it.qty);
      for (const [pid, q] of Object.entries(need2)) {
        const pr = S.data.products.find(x => x.id === Number(pid));
        need(pr && ctx.num(pr.stock) >= q, `cannot void: the ${q} unit(s) of ${pr ? pr.name : pid} put back in stock by this credit note are no longer on hand`);
      }
      const rev = (ref_type, memo) => {
        const orig = S.data.journal.filter(j => j.ref_type === ref_type && j.ref_id === cn.id);
        need(orig.length === 1, `the original ${ref_type} posting was not found exactly once; review it manually`);
        need(ctx.postJournal({ date: ctx.todayStr(), memo, ref_type: ref_type + '-void', ref_id: cn.id,
          lines: orig[0].lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })) }), 'reversal could not be posted');
      };
      rev('credit_note', `Void of credit note ${cn.number}: ${String(p.reason).trim()}`);
      if (back.length) {
        if (S.data.journal.some(j => j.ref_type === 'credit_note-cogs' && j.ref_id === cn.id)) rev('credit_note-cogs', `Void of COGS reversal for ${cn.number}`);
        ctx.applyStock(back.map(it => ({ product_id: it.product_id, qty: it.qty })), -1, { reason: 'credit-note-void', ref_type: 'credit_note', ref_id: cn.id });
      }
      inv.credited_amount = Math.max(0, r2(ctx.num(inv.credited_amount) - ctx.num(cn.total)));
      Object.assign(cn, { status: 'void', void_reason: String(p.reason).trim(), voided_by: user.username, voided_at: new Date().toISOString() });
      S.save();
      return { credit_note: cn };
    },
  },
  'purchase-return-void': {
    view: 'purchases',
    run(ctx, p, user) {
      need(user && user.role === 'admin', 'only an admin can void a purchase return');
      const S = ctx.store, r2 = v => Math.round(v * 100) / 100;
      const pr = (S.data.purchase_returns || []).find(x => x.id === Number(p.id));
      need(pr, 'purchase return not found');
      need(pr.status === 'posted', 'this purchase return is not active (already void)');
      need(String(p.reason || '').trim().length >= 5, 'a void reason of at least 5 characters is required');
      need(ctx.num(pr.refunded) < 0.005, 'this return included a confirmed supplier refund; voiding it would need that money recorded as sent back, which is not supported yet');
      const po = S.data.purchases.find(x => x.id === pr.purchase_id);
      need(po && po.status === 'received', 'the purchase is no longer in a state that can take this return back');
      const orig = S.data.journal.filter(j => j.ref_type === 'purchase_return' && j.ref_id === pr.id);
      need(orig.length === 1, 'the original purchase return posting was not found exactly once; review it manually');
      need(ctx.postJournal({ date: ctx.todayStr(), memo: `Void of purchase return ${pr.number}: ${String(p.reason).trim()}`, ref_type: 'purchase_return-void', ref_id: pr.id,
        lines: orig[0].lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })) }), 'reversal could not be posted');
      const stockItems = (pr.items || []).filter(it => it.product_id != null).map(it => ({ product_id: it.product_id, qty: it.qty }));
      if (stockItems.length) ctx.applyStock(stockItems, +1, { reason: 'purchase-return-void', ref_type: 'purchase_return', ref_id: pr.id });
      S.add('ledger', { date: ctx.todayStr(), type: 'expense', category: 'Purchase return void', amount: r2(ctx.num(pr.total)), ref_type: 'purchase_return', ref_id: pr.id, memo: `${pr.number} voided` });
      po.returned_amount = Math.max(0, r2(ctx.num(po.returned_amount) - ctx.num(pr.total)));
      Object.assign(pr, { status: 'void', void_reason: String(p.reason).trim(), voided_by: user.username, voided_at: new Date().toISOString() });
      S.save();
      return { purchase_return: pr };
    },
  },

  'purchase-return-create': {
    view: 'purchases',
    run(ctx, p, user) {
      const S = ctx.store;
      const r2 = v => Math.round(v * 100) / 100;
      S.data.purchase_returns = S.data.purchase_returns || [];
      if (p.client_ref) {
        const dup = S.data.purchase_returns.find(x => x.client_ref === String(p.client_ref));
        if (dup) return { purchase_return: dup, duplicate: true };
      }
      const po = S.data.purchases.find(x => x.id === Number(p.purchase_id));
      need(po, 'purchase not found');
      need(po.status === 'received' && po.journal_received && po.stock_applied, 'only a received purchase can be returned to the supplier');
      need(String(p.reason || '').trim().length >= 3, 'a reason is required');
      need(Array.isArray(p.items) && p.items.length > 0, 'choose at least one purchase line to return');
      const prior = {};
      for (const pr of S.data.purchase_returns.filter(x => x.purchase_id === po.id && x.status !== 'void')) {
        for (const it of pr.items) prior[it.line] = (prior[it.line] || 0) + it.qty;
      }
      const seen = new Set(), items = [], need2 = {};
      for (const raw of p.items) {
        const line = Number(raw.line);
        need(Number.isInteger(line) && line >= 0 && line < po.items.length, 'unknown purchase line');
        need(!seen.has(line), 'duplicate purchase line');
        seen.add(line);
        const qty = Number(raw.qty);
        need(Number.isFinite(qty) && qty > 0, 'return quantity must be positive');
        const src = po.items[line];
        need(qty <= Number(src.qty) - (prior[line] || 0) + 1e-9, `return quantity exceeds what is left to return on line ${line + 1}`);
        const cost = Number(src.cost != null ? src.cost : src.price);
        if (src.product_id != null) {
          const prod = S.data.products.find(x => x.id === Number(src.product_id));
          need(prod, 'product no longer exists');
          need(Math.abs(ctx.num(prod.cost) - cost) < 0.005, `${prod.name}: the product cost (${ctx.num(prod.cost)}) differs from this purchase line cost (${cost}); a return at a different cost needs a reviewed revaluation first`);
          need2[prod.id] = (need2[prod.id] || 0) + qty;
        }
        items.push({ line, product_id: src.product_id == null ? null : Number(src.product_id), description: src.description || '', qty, cost });
      }
      for (const [pid, q] of Object.entries(need2)) {
        const prod = S.data.products.find(x => x.id === Number(pid));
        need(ctx.num(prod.stock) >= q, `not enough stock of ${prod.name} on hand to send back (${ctx.num(prod.stock)} available, ${q} to return)`);
      }
      const total = r2(items.reduce((s, it) => s + it.qty * it.cost, 0));
      need(total > 0, 'return total must be positive');
      const open = ctx.purchaseOpenAmount(po);
      const toAP = Math.min(total, open);
      const excess = r2(total - toAP);
      let method = null, refundRef = null, refundBy = null;
      if (excess > 0.005) { const c = confirmedRefund(ctx, p, excess, user, 'supplier'); method = c.method; refundRef = c.reference; refundBy = c.by; }
      ctx.ensureCOA();
      const date = ctx.todayStr();
      const number = `PR-${String(S.data.meta.prSeq++).padStart(4, '0')}`;
      const pr = S.add('purchase_returns', { number, purchase_id: po.id, purchase_number: po.number, supplier_id: po.supplier_id || null, date, reason: String(p.reason).trim(),
        items, total, applied_to_payable: toAP, refunded: excess, refund_method: method, refund_reference: refundRef, refund_confirmed_by: refundBy, status: 'posted', client_ref: p.client_ref ? String(p.client_ref) : null });
      const stockItems = items.filter(it => it.product_id != null).map(it => ({ product_id: it.product_id, qty: it.qty }));
      if (stockItems.length) ctx.applyStock(stockItems, -1, { reason: 'purchase-return', ref_type: 'purchase_return', ref_id: pr.id });
      const lines = [{ account_id: ctx.accountByCode('1200').id, credit: total }];
      if (toAP > 0.005) lines.push({ account_id: ctx.accountByCode('2000').id, debit: toAP });
      if (excess > 0.005) lines.push({ account_id: ctx.settlementAccountId(method), debit: excess });
      need(ctx.postJournal({ date, memo: `Purchase return ${number} (${po.number})`, ref_type: 'purchase_return', ref_id: pr.id, lines }), 'purchase return could not be posted');
      S.add('ledger', { date, type: 'income', category: 'Purchase return', amount: total, ref_type: 'purchase_return', ref_id: pr.id, memo: `${number} returned to supplier` });
      po.returned_amount = r2(ctx.num(po.returned_amount) + total);
      S.save();
      return { purchase_return: pr };
    },
  },

  'return-create': {
    view: 'orders',
    run(ctx, p, user) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'fulfilled', 'only fulfilled orders can be returned');
      need(Array.isArray(p.items) && p.items.length > 0, 'items required');
      const inv = o.invoice_id ? S.data.invoices.find(i => i.id === o.invoice_id) : null;
      /* the server prices the return from the ORDER lines: a client-sent
         price, description or product cost is never trusted */
      const asked = {};
      for (const it of p.items) {
        const q = ctx.num(it.qty);
        need(q > 0, 'qty must be positive');
        const pid = it.product_id == null ? null : Number(it.product_id);
        if (pid != null) need(S.data.products.some(x => x.id === pid), 'unknown product in return');
        const k = pid == null ? 'null' : pid;
        asked[k] = (asked[k] || 0) + q;
      }
      const items = [];
      for (const k of Object.keys(asked)) {
        const pid = k === 'null' ? null : Number(k);
        const lines = (o.items || []).filter(x => (x.product_id == null ? null : Number(x.product_id)) === pid);
        const sold = lines.reduce((s, x) => s + ctx.num(x.qty), 0);
        const back = (S.data.returns || []).filter(r => r.order_id === o.id && r.status !== 'void').reduce((s, r) => s + (r.items || []).filter(it => (it.product_id == null ? null : Number(it.product_id)) === pid).reduce((x, it) => x + ctx.num(it.qty), 0), 0);
        need(asked[k] <= sold - back + 0.0005, `return qty exceeds sold quantity for product ${k}`);
        if (inv) need(asked[k] + (S.data.credit_notes || []).filter(c => c.invoice_id === inv.id && c.status !== 'void').reduce((s, c) => s + c.items.filter(it => (it.product_id == null ? null : Number(it.product_id)) === pid).reduce((x, it) => x + Number(it.qty), 0), 0) + back <= sold + 0.0005, 'this product has already been credited or returned (credit notes and sales-order returns together) up to the sold quantity');
        /* allocate over the order lines in order, skipping what was returned before */
        let skip = back, left = asked[k];
        for (const ln of lines) {
          if (left <= 1e-9) break;
          let avail = ctx.num(ln.qty);
          const used = Math.min(skip, avail); skip -= used; avail -= used;
          const take = Math.min(avail, left);
          if (take > 1e-9) { items.push({ product_id: pid, description: ln.description || '', qty: take, price: ctx.num(ln.price) }); left -= take; }
        }
      }
      const split = ctx.returnSplit(o, items);
      let opts = null;
      if (split.toCash > 0.005) opts = confirmedRefund(ctx, p, split.toCash, user, 'customer');
      const row = ctx.applyReturnEffects(o, items, opts);
      return { return: row };
    },
  },

  /* Void a sales-order return. Same rules as the credit-note void: admin only, reason required,
     original kept (status void), journals reversed exactly, goods taken back out of stock only if
     still on hand, rejected if any money was paid out to the customer. */
  'return-void': {
    view: 'orders',
    run(ctx, p, user) {
      need(user && user.role === 'admin', 'only an admin can void a return');
      const S = ctx.store, r2 = v => Math.round(v * 100) / 100;
      const rt = (S.data.returns || []).find(x => x.id === Number(p.id));
      need(rt, 'return not found');
      need(rt.status !== 'void', 'this return is already void');
      need(String(p.reason || '').trim().length >= 5, 'a void reason of at least 5 characters is required');
      const orig = S.data.journal.filter(j => j.ref_type === 'return' && j.ref_id === rt.id);
      need(orig.length === 1, 'the original return posting was not found exactly once; review it manually');
      const ar = S.data.accounts.find(a => a.code === '1100');
      const paidOut = orig[0].lines.filter(l => !ar || l.account_id !== ar.id).reduce((s, l) => s + ctx.num(l.credit), 0);
      need(paidOut < 0.005 && !rt.refund_confirmed_by, 'this return paid money back to the customer; voiding it would need that money recorded as returned, which is not supported yet');
      const need2 = {};
      for (const it of (rt.items || [])) if (it.product_id != null) need2[it.product_id] = (need2[it.product_id] || 0) + ctx.num(it.qty);
      for (const [pid, q] of Object.entries(need2)) {
        const pr = S.data.products.find(x => x.id === Number(pid));
        need(pr && ctx.num(pr.stock) >= q, `cannot void: the ${q} unit(s) of ${pr ? pr.name : pid} put back in stock by this return are no longer on hand`);
      }
      const rev = (j, memo, rtype) => need(ctx.postJournal({ date: ctx.todayStr(), memo, ref_type: rtype, ref_id: rt.id,
        lines: j.lines.map(l => ({ account_id: l.account_id, debit: l.credit, credit: l.debit })) }), 'reversal could not be posted');
      rev(orig[0], `Void of return ${rt.number}: ${String(p.reason).trim()}`, 'return-void');
      const cg = S.data.journal.filter(j => j.ref_type === 'return-cogs' && j.ref_id === rt.id);
      if (cg.length === 1) rev(cg[0], `Void of COGS reversal for ${rt.number}`, 'return-cogs-void');
      const st = (rt.items || []).filter(it => it.product_id != null).map(it => ({ product_id: it.product_id, qty: it.qty }));
      if (st.length) ctx.applyStock(st, -1, { reason: 'return-void', ref_type: 'return', ref_id: rt.id });
      Object.assign(rt, { status: 'void', void_reason: String(p.reason).trim(), voided_by: user.username, voided_at: new Date().toISOString() });
      S.save();
      return { return: rt };
    },
  },

  /* ---------------- helpdesk ---------------- */
  'ticket-save': {
    view: 'helpdesk',
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const now = new Date().toISOString();
      const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
      const STATUSES = ['open', 'in-progress', 'resolved', 'closed'];
      need(String(out.subject || '').trim(), 'subject required');
      need(!out.contact_id || S.data.contacts.some(c => c.id === Number(out.contact_id)), 'customer not found');
      const assignee = String(out.assigned_to || '').trim();
      /* assignment is validated against real accounts — a forged username
         would route work to a person who cannot see it */
      need(!assignee || (ctx.dbUsers || []).some(u => u.username === assignee), 'assignee not found');
      if (p.id || out.id) {
        const tk = (S.data.tickets || []).find(x => x.id === Number(p.id || out.id));
        need(tk, 'ticket not found');
        /* shared queue: any helpdesk agent may pick up and work a ticket;
           authorship stays session-derived on tickets and replies, and
           deletion stays restricted (ticket-delete below) */
        Object.assign(tk, {
          subject: String(out.subject).trim(), description: String(out.description || ''),
          contact_id: out.contact_id || null,
          priority: PRIORITIES.includes(out.priority) ? out.priority : tk.priority,
          status: STATUSES.includes(out.status) ? out.status : tk.status,
          assigned_to: assignee || null, updated_at: now,
        });
        S.save();
        return { ticket: tk };
      }
      /* identity and numbering come from the server, never the payload */
      const row = S.add('tickets', {
        number: `TKT-${String(S.data.meta.ticketSeq++).padStart(4, '0')}`,
        subject: String(out.subject).trim(), description: String(out.description || ''),
        contact_id: out.contact_id || null,
        priority: PRIORITIES.includes(out.priority) ? out.priority : 'medium',
        status: 'open', assigned_to: assignee || null,
        created_by: user.username, created_at: now, updated_at: now,
      });
      S.save();
      return { ticket: row };
    },
  },
  'ticket-status': {
    view: 'helpdesk',
    run(ctx, p) {
      const S = ctx.store;
      const tk = (S.data.tickets || []).find(x => x.id === Number(p.id));
      need(tk, 'ticket not found');
      need(['open', 'in-progress', 'resolved', 'closed'].includes(p.status), 'unknown status');
      tk.status = p.status;
      tk.updated_at = new Date().toISOString();
      S.save();
      return { ticket: tk };
    },
  },
  'ticket-reply': {
    view: 'helpdesk',
    run(ctx, p, user) {
      const S = ctx.store;
      const tk = (S.data.tickets || []).find(x => x.id === Number(p.ticket_id));
      need(tk, 'ticket not found');
      need(String(p.body || '').trim(), 'reply required');
      /* author comes from the session; internal notes are a flag the
         client cannot use to forge authorship */
      const row = S.add('ticket_replies', {
        ticket_id: tk.id, author: user.username, body: String(p.body).trim(),
        internal: !!p.internal, created_at: new Date().toISOString(),
      });
      tk.updated_at = row.created_at;
      S.save();
      return { reply: row };
    },
  },
  'ticket-delete': {
    view: 'helpdesk',
    run(ctx, p, user) {
      const S = ctx.store;
      const tk = (S.data.tickets || []).find(x => x.id === Number(p.id));
      need(tk, 'ticket not found');
      need(user.role === 'admin' || tk.created_by === user.username, 'only the creator or admin can delete');
      S.data.tickets = S.data.tickets.filter(x => x.id !== tk.id);
      S.data.ticket_replies = (S.data.ticket_replies || []).filter(r => r.ticket_id !== tk.id);
      S.save();
      return { deleted: tk.id };
    },
  },

  /* ---------------- quality + document control ---------------- */

  'qc-save': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const now = new Date().toISOString();
      const TYPES = ['incoming', 'in-process', 'final'];
      need(String(out.title || '').trim(), 'title required');
      need(!out.product_id || S.data.products.some(x => x.id === Number(out.product_id)), 'product not found');
      const inspected = qcQty(out.qty_inspected, 'inspected quantity');
      if (p.id) {
        const q = (S.data.quality_checks || []).find(x => x.id === Number(p.id));
        need(q, 'inspection not found');
        need(q.status === 'open', 'a closed inspection cannot be edited');
        Object.assign(q, {
          title: String(out.title).trim(), type: TYPES.includes(out.type) ? out.type : q.type,
          product_id: out.product_id ? Number(out.product_id) : null,
          reference: String(out.reference || ''), qty_inspected: inspected,
          notes: String(out.notes || ''), updated_at: now,
        });
        S.save();
        return { check: q };
      }
      /* number, inspector, result and status are server-set: the client
         cannot pre-fill a "pass" or another person's name */
      const row = S.add('quality_checks', {
        number: `QC-${String(S.data.meta.qcSeq++).padStart(4, '0')}`,
        title: String(out.title).trim(), type: TYPES.includes(out.type) ? out.type : 'incoming',
        product_id: out.product_id ? Number(out.product_id) : null,
        reference: String(out.reference || ''), qty_inspected: inspected, qty_failed: 0,
        notes: String(out.notes || ''), result: 'pending', status: 'open', corrective_action: '',
        created_by: user.username, created_at: now, updated_at: now,
      });
      S.save();
      return { check: row };
    },
  },
  'qc-result': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const q = (S.data.quality_checks || []).find(x => x.id === Number(p.id));
      need(q, 'inspection not found');
      need(q.status === 'open', 'a closed inspection cannot be changed');
      need(['pass', 'fail'].includes(p.result), 'result must be pass or fail');
      need(!(q.result === 'fail' && p.result === 'pass'), 'a recorded failure cannot be changed to pass: close it with a corrective action (or an admin voids it with a reason)');
      const failed = p.result === 'fail' ? qcQty(p.qty_failed, 'failed quantity') : 0;
      if (p.result === 'fail') need(failed <= q.qty_inspected, 'failed quantity cannot exceed the inspected quantity');
      q.result = p.result; q.qty_failed = failed;
      q.inspected_by = user.username; q.inspected_at = new Date().toISOString(); q.updated_at = q.inspected_at;
      if (p.result === 'pass') { q.status = 'closed'; q.closed_at = q.inspected_at; }
      S.save();
      return { check: q };
    },
  },
  'qc-close': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const q = (S.data.quality_checks || []).find(x => x.id === Number(p.id));
      need(q, 'inspection not found');
      need(q.status === 'open', 'already closed');
      need(q.result === 'fail', 'only a failed inspection needs a corrective action to close');
      need(String(p.corrective_action || '').trim().length >= 5, 'corrective action required to close a nonconformance');
      q.corrective_action = String(p.corrective_action).trim();
      q.status = 'closed'; q.closed_by = user.username; q.closed_at = new Date().toISOString(); q.updated_at = q.closed_at;
      S.save();
      return { check: q };
    },
  },
  'qc-delete': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const q = (S.data.quality_checks || []).find(x => x.id === Number(p.id));
      need(q, 'inspection not found');
      /* only a never-inspected record may be removed; anything with a result
         is history and can only be voided (kept, flagged, attributed) */
      need(q.result === 'pending' && !q.voided, 'an inspected record cannot be deleted: void it with a reason');
      need(user.role === 'admin' || q.created_by === user.username, 'only the creator or admin can delete');
      S.data.quality_checks = S.data.quality_checks.filter(x => x.id !== q.id);
      S.save();
      return { deleted: q.id };
    },
  },
  'qc-void': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const q = (S.data.quality_checks || []).find(x => x.id === Number(p.id));
      need(q, 'inspection not found');
      need(user.role === 'admin', 'only admin can void an inspection record');
      need(q.result !== 'pending', 'a never-inspected record is deleted, not voided');
      need(!q.voided, 'already voided');
      need(String(p.reason || '').trim().length >= 5, 'a void reason is required');
      q.voided = true; q.void_reason = String(p.reason).trim(); q.voided_by = user.username; q.voided_at = new Date().toISOString();
      q.status = 'voided'; q.updated_at = q.voided_at;
      S.save();
      return { check: q };
    },
  },
  'doc-save': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const now = new Date().toISOString();
      need(String(out.title || '').trim(), 'title required');
      const DT = ['policy', 'procedure', 'work-instruction', 'contract', 'form', 'other'];
      if (p.id) {
        const d = (S.data.documents || []).find(x => x.id === Number(p.id));
        need(d, 'document not found');
        need(d.status === 'draft', 'only a draft can be edited: send a document in review back to draft, or revise an approved one');
        Object.assign(d, { title: String(out.title).trim(), doc_type: DT.includes(out.doc_type) ? out.doc_type : d.doc_type,
          location: String(out.location || ''), summary: String(out.summary || ''), updated_at: now });
        S.save();
        return { document: d };
      }
      const row = S.add('documents', {
        number: `DOC-${String(S.data.meta.docSeq++).padStart(4, '0')}`,
        title: String(out.title).trim(), doc_type: DT.includes(out.doc_type) ? out.doc_type : 'other',
        location: String(out.location || ''), summary: String(out.summary || ''),
        version: 1, status: 'draft', owner: user.username,
        history: [{ version: 1, by: user.username, at: now, note: 'created' }],
        created_at: now, updated_at: now,
      });
      S.save();
      return { document: row };
    },
  },
  'doc-status': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const d = (S.data.documents || []).find(x => x.id === Number(p.id));
      need(d, 'document not found');
      const now = new Date().toISOString();
      const to = p.status;
      const allowed = { draft: ['review'], review: ['approved', 'draft'], approved: ['obsolete'], obsolete: [] };
      need((allowed[d.status] || []).includes(to), `cannot move from ${d.status} to ${to}`);
      if (to === 'approved') {
        /* separation of duties: the owner cannot approve their own document */
        need(d.owner !== user.username, 'a document cannot be approved by its owner');
        d.approved_by = user.username; d.approved_at = now;
      }
      d.status = to; d.updated_at = now;
      d.history.push({ version: d.version, by: user.username, at: now, note: `status: ${to}` });
      S.save();
      return { document: d };
    },
  },
  'doc-revise': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const d = (S.data.documents || []).find(x => x.id === Number(p.id));
      need(d, 'document not found');
      need(d.status === 'approved', 'only an approved document is revised');
      need(String(p.note || '').trim(), 'revision note required');
      const now = new Date().toISOString();
      d.version += 1; d.status = 'draft'; d.owner = user.username;
      delete d.approved_by; delete d.approved_at; d.updated_at = now;
      d.history.push({ version: d.version, by: user.username, at: now, note: String(p.note).trim() });
      S.save();
      return { document: d };
    },
  },
  'doc-delete': {
    view: 'quality', nonFinancial: true,
    run(ctx, p, user) {
      const S = ctx.store;
      const d = (S.data.documents || []).find(x => x.id === Number(p.id));
      need(d, 'document not found');
      /* only a draft that was never reviewed, approved or revised may go;
         everything else keeps its history (mark it obsolete instead) */
      need(d.status === 'draft' && d.version === 1 && d.history.length === 1, 'a document with history cannot be deleted: mark it obsolete');
      need(user.role === 'admin' || d.owner === user.username, 'only the owner or admin can delete');
      S.data.documents = S.data.documents.filter(x => x.id !== d.id);
      S.save();
      return { deleted: d.id };
    },
  },

  /* ---------------- HR: time off + attendance ---------------- */
  'leave-save': {
    view: ['employees', 'hr-self'],
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      /* self-service users are bound to their admin-linked employee record:
         a caller-chosen employee_id cannot bypass the own-approval rule */
      const selfOnly = user.role !== 'admin' && !(user.modules || []).includes('employees');
      if (selfOnly) {
        need(user.employee_id, 'no employee record linked to this account');
        out.employee_id = user.employee_id;
      }
      const emp = (S.data.employees || []).find(e => e.id === Number(out.employee_id));
      need(emp, 'employee not found');
      need(['annual', 'sick', 'unpaid'].includes(out.type), 'unknown leave type');
      need(/^\d{4}-\d{2}-\d{2}$/.test(out.from_date || '') && /^\d{4}-\d{2}-\d{2}$/.test(out.to_date || ''), 'dates required');
      need(out.from_date <= out.to_date, 'from date must not be after to date');
      const days = Math.round((new Date(out.to_date) - new Date(out.from_date)) / 86400000) + 1;
      if (p.id || out.id) {
        const lr = (S.data.leave_requests || []).find(x => x.id === Number(p.id || out.id));
        need(lr, 'leave request not found');
        need(lr.status === 'submitted', 'only a pending request can be edited');
        need(user.role === 'admin' || lr.requested_by === user.username, 'only the requester can edit it');
        Object.assign(lr, {
          employee_id: emp.id, type: out.type, from_date: out.from_date, to_date: out.to_date,
          days, reason: String(out.reason || ''),
        });
        S.save();
        return { leave: lr };
      }
      /* requester identity comes from the session, never the payload */
      const row = S.add('leave_requests', {
        employee_id: emp.id, type: out.type, from_date: out.from_date, to_date: out.to_date,
        days, reason: String(out.reason || ''), status: 'submitted',
        requested_by: user.username, decided_by: null, decided_at: null, decision_note: '',
        created_at: new Date().toISOString(),
      });
      S.save();
      return { leave: row };
    },
  },
  'leave-decide': {
    view: 'employees',
    run(ctx, p, user) {
      const S = ctx.store;
      const lr = (S.data.leave_requests || []).find(x => x.id === Number(p.id));
      need(lr, 'leave request not found');
      need(lr.status === 'submitted', 'request is not awaiting a decision');
      need(['approved', 'rejected'].includes(p.decision), 'unknown decision');
      /* separation of duties, mirroring expenses: an employee cannot decide
         their own request; the admin (owner) can */
      need(user.role === 'admin' || lr.requested_by !== user.username, 'you cannot decide your own leave request');
      need(p.decision !== 'rejected' || String(p.note || '').trim(), 'rejection needs a reason');
      lr.status = p.decision;
      lr.decided_by = user.username;
      lr.decided_at = new Date().toISOString();
      lr.decision_note = String(p.note || '');
      S.save();
      return { leave: lr };
    },
  },
  'leave-delete': {
    view: ['employees', 'hr-self'],
    run(ctx, p, user) {
      const S = ctx.store;
      const lr = (S.data.leave_requests || []).find(x => x.id === Number(p.id));
      need(lr, 'leave request not found');
      need(lr.status === 'submitted', 'a decided request is part of the record and stays');
      need(user.role === 'admin' || lr.requested_by === user.username, 'only the requester can delete it');
      S.data.leave_requests = S.data.leave_requests.filter(x => x.id !== lr.id);
      S.save();
      return { deleted: lr.id };
    },
  },
  'attendance-save': {
    view: ['employees', 'hr-self'],
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      const selfOnly = user.role !== 'admin' && !(user.modules || []).includes('employees');
      if (selfOnly) {
        need(user.employee_id, 'no employee record linked to this account');
        out.employee_id = user.employee_id;
      }
      const emp = (S.data.employees || []).find(e => e.id === Number(out.employee_id));
      need(emp, 'employee not found');
      need(/^\d{4}-\d{2}-\d{2}$/.test(out.date || ''), 'date required');
      const HHMM = v => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || '');
      need(!out.check_in || HHMM(out.check_in), 'check-in must be HH:MM');
      need(!out.check_out || HHMM(out.check_out), 'check-out must be HH:MM');
      /* hours are computed server-side; a client-sent hours field is
         ignored. Overnight shifts (check-out earlier than check-in) count
         past midnight instead of silently zeroing out. */
      let hours = 0;
      if (HHMM(out.check_in) && HHMM(out.check_out)) {
        const [h1, m1] = out.check_in.split(':').map(Number);
        const [h2, m2] = out.check_out.split(':').map(Number);
        let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
        if (mins < 0) mins += 24 * 60;
        hours = Math.round(mins / 6) / 10;
      }
      /* one record per employee per day: saving again corrects it */
      const existing = (S.data.attendance || []).find(a => a.employee_id === emp.id && a.date === out.date);
      if (existing) {
        need(user.role === 'admin' || existing.recorded_by === user.username, 'only the recorder or admin can correct it');
        Object.assign(existing, { check_in: out.check_in || '', check_out: out.check_out || '', hours, note: String(out.note || '') });
        S.save();
        return { entry: existing };
      }
      const row = S.add('attendance', {
        employee_id: emp.id, date: out.date, check_in: out.check_in || '', check_out: out.check_out || '',
        hours, note: String(out.note || ''), recorded_by: user.username,
      });
      S.save();
      return { entry: row };
    },
  },
  'attendance-delete': {
    view: ['employees', 'hr-self'],
    run(ctx, p, user) {
      const S = ctx.store;
      const a = (S.data.attendance || []).find(x => x.id === Number(p.id));
      need(a, 'attendance record not found');
      need(user.role === 'admin' || a.recorded_by === user.username, 'only the recorder or admin can delete it');
      S.data.attendance = S.data.attendance.filter(x => x.id !== a.id);
      S.save();
      return { deleted: a.id };
    },
  },

  /* ---------------- fixed assets ---------------- */
  'asset-save': {
    view: 'assets',
    run(ctx, p, user) {
      const S = ctx.store;
      const out = p.out || {};
      need(String(out.name || '').trim(), 'name required');
      const cost = Math.round(ctx.num(out.cost) * 100) / 100;
      const salvage = Math.round(ctx.num(out.salvage) * 100) / 100;
      const life = Math.round(ctx.num(out.life_months));
      need(cost > 0 && cost <= MAXAMT, 'cost must be positive');
      need(salvage >= 0 && salvage < cost, 'salvage must be below cost');
      need(life >= 1 && life <= 600, 'useful life must be 1-600 months');
      need(validDate(out.purchase_date), 'purchase date required (a real YYYY-MM-DD date)');
      if (p.id || out.id) {
        const a = (S.data.assets || []).find(x => x.id === Number(p.id || out.id));
        need(a, 'asset not found');
        /* financial terms are locked once depreciation has run — changing
           them retroactively would rewrite posted journal history */
        need(!a.depr_through && !a.opening_recognized, 'depreciation already posted: financial terms are locked');
        need(a.status === 'active', 'a disposed asset cannot be edited');
        Object.assign(a, {
          name: String(out.name).trim(), category: String(out.category || ''),
          purchase_date: out.purchase_date, cost, salvage, life_months: life,
        });
        S.save();
        return { asset: a };
      }
      const row = S.add('assets', {
        name: String(out.name).trim(), category: String(out.category || ''),
        purchase_date: out.purchase_date, cost, salvage, life_months: life,
        status: 'active', depr_through: null, disposed_date: null, proceeds: null,
        created_by: user.username, created_at: new Date().toISOString(),
      });
      /* acquisition posting is an explicit opt-in, never implicit */
      if (out.post_acquisition) {
        ctx.postJournal({
          date: out.purchase_date, memo: `Asset acquisition - ${row.name}`, ref_type: 'asset', ref_id: row.id,
          lines: [
            { account_id: ctx.accountByCode('1500').id, debit: cost },
            { account_id: ctx.accountByCode('1000').id, credit: cost },
          ],
        });
        row.acquisition_posted = true;
      }
      S.save();
      return { asset: row };
    },
  },
  'asset-depreciate': {
    view: 'assets',
    run(ctx, p) {
      /* explicit monthly run: posts one straight-line month per active asset
         per elapsed unposted month. The per-asset cursor makes a re-run for
         the same month a no-op; a long gap surfaces as a catch-up count. */
      const S = ctx.store;
      need(/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month || ''), 'month required (YYYY-MM)');
      const month = p.month;
      need(FUTURE_OK || month <= ctx.monthStr(), 'depreciation cannot be posted for a future month');
      let posted = 0;
      const details = [];
      let skipped_unrecognized = 0;
      for (const a of (S.data.assets || [])) {
        if (a.status !== 'active') continue;
        /* a register-only asset was never recognized on the balance sheet:
           no GL depreciation may post against it. Its register row keeps a
           visibly separate tracking-only figure until an admin runs an
           explicit opening recognition. */
        if (!a.acquisition_posted && !a.opening_recognized) { skipped_unrecognized++; continue; }
        const purchaseMonth = (a.purchase_date || '').slice(0, 7);
        if (!purchaseMonth || month <= purchaseMonth) continue;
        if (a.depr_through && month <= a.depr_through) continue;
        const monthly = Math.round((a.cost - a.salvage) / a.life_months * 100) / 100;
        if (monthly <= 0) continue;
        /* catch-up: every month after the cursor through the requested one */
        let cur = a.depr_through || purchaseMonth;
        let guard = 0;
        while (cur < month && guard++ < 60) {
          const [y, m] = cur.split('-').map(Number);
          cur = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
          const accum = ctx.accumDepr(a.id) + ctx.num(a.opening_accum);
          if (accum + monthly > a.cost - a.salvage + 0.005) { a.depr_through = cur; continue; }
          ctx.postJournal({
            date: `${cur}-28`, memo: `Depreciation ${cur} - ${a.name}`, ref_type: 'asset-depr', ref_id: a.id,
            lines: [
              { account_id: ctx.accountByCode('6200').id, debit: monthly },
              { account_id: ctx.accountByCode('1590').id, credit: monthly },
            ],
          });
          a.depr_through = cur;
          posted++;
        }
        details.push(`${a.name}: ${a.depr_through}`);
      }
      need(posted > 0 || skipped_unrecognized > 0, 'nothing to post for this month');
      S.save();
      return { posted, details, skipped_unrecognized };
    },
  },
  'asset-dispose': {
    view: 'assets',
    run(ctx, p) {
      const S = ctx.store;
      const a = (S.data.assets || []).find(x => x.id === Number(p.id));
      need(a, 'asset not found');
      need(a.status === 'active', 'asset already disposed');
      need(validDate(p.date), 'disposal date required (a real YYYY-MM-DD date)');
      need(p.date >= a.purchase_date, 'disposal date cannot be before the purchase date');
      need(!a.depr_through || p.date.slice(0, 7) >= a.depr_through, 'disposal date is before depreciation already posted; dispose on or after that month');
      const proceeds = Math.round(ctx.num(p.proceeds) * 100) / 100;
      need(proceeds >= 0 && proceeds <= MAXAMT, 'proceeds must not be negative');
      const recognized = !!(a.acquisition_posted || a.opening_recognized);
      if (!recognized) {
        /* never recognized on the balance sheet: disposal is register-only.
           No GL entry at all — not even proceeds — because there is no
           recognized cost basis to clear. Recognize the asset first if it
           belongs in the books. Proceeds stay a memo on the register row. */
        a.status = 'disposed';
        a.disposed_date = p.date;
        a.proceeds = proceeds;
        S.save();
        return { asset: a, gl_posted: false };
      }
      /* depreciation reversed out = opening recognition + posted monthly runs */
      const accum = Math.round((ctx.accumDepr(a.id) + ctx.num(a.opening_accum)) * 100) / 100;
      const book = Math.round((a.cost - accum) * 100) / 100;
      const lines = [
        { account_id: ctx.accountByCode('1590').id, debit: accum },
        { account_id: ctx.accountByCode('1500').id, credit: a.cost },
      ];
      if (proceeds > 0) lines.unshift({ account_id: ctx.accountByCode('1000').id, debit: proceeds });
      const diff = Math.round((proceeds - book) * 100) / 100;
      if (diff > 0) lines.push({ account_id: ctx.accountByCode('7100').id, credit: diff });
      if (diff < 0) lines.push({ account_id: ctx.accountByCode('6900').id, debit: -diff });
      ctx.postJournal({ date: p.date, memo: `Disposal - ${a.name}`, ref_type: 'asset-dispose', ref_id: a.id, lines });
      a.status = 'disposed';
      a.disposed_date = p.date;
      a.proceeds = proceeds;
      S.save();
      return { asset: a, gl_posted: true, book_value: book, gain_loss: diff };
    },
  },
  'asset-recognize': {
    view: 'assets',
    run(ctx, p, user) {
      /* explicit opening recognition: brings a register-only asset onto the
         balance sheet at cost, with its accumulated depreciation so far
         against equity. This is an accounting decision, so it is an
         admin-only, deliberately-invoked event — never inferred. */
      need(user.role === 'admin', 'only an admin can recognize an asset in the books');
      const S = ctx.store;
      const a = (S.data.assets || []).find(x => x.id === Number(p.id));
      need(a, 'asset not found');
      need(a.status === 'active', 'a disposed asset cannot be recognized');
      need(!a.acquisition_posted && !a.opening_recognized, 'asset is already recognized in the books');
      const oa = Math.round(ctx.num(p.opening_accum) * 100) / 100;
      need(oa >= 0 && oa <= a.cost - a.salvage + 0.005, 'opening accumulated depreciation out of range');
      need(validDate(p.date), 'recognition date required (a real YYYY-MM-DD date)');
      const net = Math.round((a.cost - oa) * 100) / 100;
      const lines = [{ account_id: ctx.accountByCode('1500').id, debit: a.cost }];
      if (oa > 0) lines.push({ account_id: ctx.accountByCode('1590').id, credit: oa });
      if (net > 0) lines.push({ account_id: ctx.accountByCode('3000').id, credit: net });
      ctx.postJournal({ date: p.date, memo: `Opening recognition - ${a.name}`, ref_type: 'asset-recognize', ref_id: a.id, lines });
      a.opening_recognized = true;
      a.opening_accum = oa;
      a.recognized_date = p.date;
      a.recognized_by = user.username;
      /* monthly posting resumes after the recognition month: opening
         accumulated covers everything before it */
      a.depr_through = p.date.slice(0, 7);
      S.save();
      return { asset: a };
    },
  },
  'asset-delete': {
    view: 'assets',
    run(ctx, p, user) {
      const S = ctx.store;
      const a = (S.data.assets || []).find(x => x.id === Number(p.id));
      need(a, 'asset not found');
      need(!a.depr_through && !a.acquisition_posted && !a.opening_recognized && a.status === 'active', 'an asset with posted history stays in the register');
      need(user.role === 'admin' || a.created_by === user.username, 'only the creator or admin can delete');
      S.data.assets = S.data.assets.filter(x => x.id !== a.id);
      S.save();
      return { deleted: a.id };
    },
  },

  /* ---------------- point of sale ---------------- */
  'pos-sale': {
    view: 'pos',
    run(ctx, p, user) {
      /* one explicit charge = sent invoice + payment + stock + journal in a
         single serialized transaction. client_ref makes a double-tap or a
         retried submission idempotent instead of a duplicate sale. */
      const S = ctx.store;
      const ref = String(p.client_ref || '').trim();
      need(ref, 'client reference required');
      const dup = (S.data.invoices || []).find(i => i.pos_ref === ref);
      if (dup) return { invoice: dup, duplicate: true };
      need(Array.isArray(p.items) && p.items.length > 0, 'items required');
      for (const it of p.items) {
        const prod = S.data.products.find(x => x.id === Number(it.product_id));
        need(prod, 'unknown product');
        need(ctx.num(it.qty) > 0, 'qty must be positive');
        need(ctx.num(prod.stock) >= ctx.num(it.qty) - 0.0005, `Insufficient stock for ${prod.name}`);
        it.price = ctx.num(prod.price); /* price comes from the catalog, never the till */
      }
      const shift = p.shift_id ? (S.data.pos_shifts || []).find(x => x.id === Number(p.shift_id) && x.status === 'open') : null;
      need(!p.shift_id || shift, 'shift not open');
      const method = ['cash', 'bank', 'transfer', 'card'].includes(p.method) ? p.method : 'cash';
      const today = ctx.todayStr();
      const taxRate = ctx.num(S.data.settings && S.data.settings.tax_rate); /* the till can never choose the tax rate */
      need(taxRate >= 0 && taxRate <= 100, 'tax rate out of range');
      ctx.saveInvoice(null, {
        status: 'sent', contact_id: null, deal_id: null,
        issue_date: today, due_date: today, tax_rate: taxRate,
        notes: 'POS', items: p.items.map(it => ({ product_id: Number(it.product_id), qty: ctx.num(it.qty), price: it.price })),
      });
      const inv = S.data.invoices[S.data.invoices.length - 1];
      inv.pos_ref = ref;
      /* a charge that cannot record its payment must fail loudly — never a
         paid-looking sale with no receipt in the books */
      need(ctx.recordPayment({
        direction: 'in', ref_type: 'invoice', ref_id: inv.id,
        amount: ctx.invoiceTotal(inv), method, date: today, memo: `POS ${inv.number}`,
      }), 'payment could not be recorded');
      if (shift) inv.pos_shift_id = shift.id;
      inv.pos_method = method;
      if (shift) {
        shift.sales_total = Math.round((ctx.num(shift.sales_total) + ctx.invoiceTotal(inv)) * 100) / 100;
        shift['sales_' + method] = Math.round((ctx.num(shift['sales_' + method]) + ctx.invoiceTotal(inv)) * 100) / 100;
      }
      S.save();
      return { invoice: inv };
    },
  },
  'pos-refund': {
    view: 'pos',
    run(ctx, p, user) {
      /* full refund of a till sale: restock, reverse revenue AND VAT, and
         pay the money back through the SAME settlement account the sale
         used (cash -> till 1000, bank/transfer -> 1010). One time only. */
      const S = ctx.store;
      const inv = (S.data.invoices || []).find(i => i.id === Number(p.id));
      need(inv, 'invoice not found');
      need(inv.pos_ref, 'not a POS sale');
      need(inv.status === 'paid', 'only a paid POS sale can be refunded');
      need(ctx.invoiceCreditedTotal(inv) < 0.005, 'this sale already has a credit note or return; a full refund would credit it twice');
      const method = ['cash', 'bank', 'transfer', 'card'].includes(p.method) ? p.method : (inv.pos_method || 'cash');
      const today = ctx.todayStr();
      const total = Math.round(ctx.invoiceTotal(inv) * 100) / 100;
      const sub = Math.round((inv.items || []).reduce((t2, it) => t2 + ctx.num(it.qty) * ctx.num(it.price), 0) * 100) / 100;
      const tax = Math.round((total - sub) * 100) / 100;
      let cogs = 0;
      for (const it of (inv.items || [])) {
        const prod = S.data.products.find(x => x.id === Number(it.product_id));
        if (!prod) continue;
        cogs += ctx.num(prod.cost) * ctx.num(it.qty);
        /* bare stock move: adjustStock would post its own adjustment
           journal on top of the COGS reversal below (double-post) */
        ctx.recordStockMove({ product_id: prod.id, warehouse_id: it.warehouse_id || prod.warehouse_id || null, qty: ctx.num(it.qty), reason: 'pos-refund', ref_type: 'pos-refund', ref_id: inv.id, memo: `POS refund ${inv.number}` });
      }
      cogs = Math.round(cogs * 100) / 100;
      const lines = [
        { account_id: ctx.accountByCode('4000').id, debit: sub },
      ];
      if (tax > 0) lines.push({ account_id: ctx.accountByCode('2100').id, debit: tax });
      /* The money leaves from where it is ACTUALLY paid out — the payout
         method (default: the sale's own method) picks the account.
         Ambiguous legacy sales are blocked instead: a pre-fix sale whose
         method says bank/transfer/card but whose payment was booked into
         the till (1000) means we cannot know where the money really is.
         An admin must review and post the settlement reclass first — the
         reclass fixes the original posting, then the refund pays out
         normally. No silent reclassification, no memo contradicting the
         journal. */
      const origPay = (S.data.payments || []).find(pay => pay.ref_type === 'invoice' && Number(pay.ref_id) === inv.id && pay.direction === 'in' && pay.journal_id);
      if (origPay && !origPay.reclassed) {
        const oj = (S.data.journal || []).find(j => j.id === origPay.journal_id);
        const arId = ctx.accountByCode('1100').id;
        const cashId = ctx.accountByCode('1000').id;
        const debitLine = oj && (oj.lines || []).find(l => ctx.num(l.debit) > 0 && l.account_id !== arId);
        const bookedCash = debitLine && debitLine.account_id === cashId;
        const methodNonCash = ['bank', 'transfer', 'card'].includes(origPay.method || inv.pos_method);
        need(!(bookedCash && methodNonCash), 'legacy settlement mismatch: sale booked to cash but paid by ' + (origPay.method || inv.pos_method) + ' — an admin must review the settlement reclass in Accounting before refunding');
      }
      const settleCode = ['bank', 'transfer', 'card'].includes(method) ? '1010' : '1000';
      lines.push({ account_id: ctx.accountByCode(settleCode).id, credit: total });
      if (cogs > 0) {
        lines.push({ account_id: ctx.accountByCode('1200').id, debit: cogs });
        lines.push({ account_id: ctx.accountByCode('5000').id, credit: cogs });
      }
      ctx.postJournal({ date: today, memo: `POS refund - ${inv.number}`, ref_type: 'pos-refund', ref_id: inv.id, lines });
      S.add('payments', {
        date: today, direction: 'out', contact_id: inv.contact_id || null, supplier_id: null,
        amount: total, method, ref_type: 'invoice', ref_id: inv.id, memo: `POS refund ${inv.number}`, journal_id: null,
      });
      inv.status = 'refunded';
      /* refund cash leaves the till that is open NOW (the refunding
         cashier's), never a closed shift's frozen numbers */
      const openShift = (S.data.pos_shifts || []).find(x => x.status === 'open' && x.cashier === user.username);
      if (openShift) openShift['refund_' + method] = Math.round((ctx.num(openShift['refund_' + method]) + total) * 100) / 100;
      S.save();
      return { invoice: inv };
    },
  },
  'pos-shift-open': {
    view: 'pos',
    run(ctx, p, user) {
      const S = ctx.store;
      /* one open shift per cashier at a time */
      need(!(S.data.pos_shifts || []).some(x => x.status === 'open' && x.cashier === user.username), 'you already have an open shift');
      need(p.opening_float == null || p.opening_float === '' || (Number.isFinite(Number(p.opening_float)) && Number(p.opening_float) >= 0 && Number(p.opening_float) <= 1e9), 'opening float must be zero or more');
      const row = S.add('pos_shifts', {
        cashier: user.username, status: 'open', opened_at: new Date().toISOString(),
        opening_float: Math.round(ctx.num(p.opening_float) * 100) / 100,
        sales_total: 0, sales_cash: 0, sales_bank: 0, sales_transfer: 0, sales_card: 0,
        refund_cash: 0, refund_bank: 0, refund_transfer: 0, refund_card: 0,
        closed_at: null, counted_cash: null, variance: null,
      });
      S.save();
      return { shift: row };
    },
  },
  'pos-shift-close': {
    view: 'pos',
    run(ctx, p, user) {
      const S = ctx.store;
      const sh = (S.data.pos_shifts || []).find(x => x.id === Number(p.id));
      need(sh, 'shift not found');
      need(sh.status === 'open', 'shift already closed');
      need(user.role === 'admin' || sh.cashier === user.username, 'only the cashier or admin can close it');
      /* closing records the count and the variance; it never posts a
         financial adjustment — a variance stays a review item, not a book
         entry nobody approved */
      need(Number.isFinite(Number(p.counted_cash)) && Number(p.counted_cash) >= 0 && Number(p.counted_cash) <= 1e9, 'counted cash must be zero or more');
      const counted = Math.round(ctx.num(p.counted_cash) * 100) / 100;
      /* expected CASH only: card/transfer sales never entered the till, and
         refunds paid out in cash reduce it */
      const expectedCash = Math.round((ctx.num(sh.opening_float) + ctx.num(sh.sales_cash) - ctx.num(sh.refund_cash)) * 100) / 100;
      sh.status = 'closed';
      sh.closed_at = new Date().toISOString();
      sh.counted_cash = counted;
      sh.expected_cash = expectedCash;
      sh.variance = Math.round((counted - expectedCash) * 100) / 100;
      S.save();
      return { shift: sh };
    },
  },
};

/* ---------------- engine ---------------- */

/* Run one transaction against db (mutated in place on success only).
   Returns { ok:true, result } or { ok:false, error, violations? }. */
function runTx(db, user, op, payload, canView) {
  const spec = OPS[op];
  if (!spec) return { ok: false, error: 'unknown operation' };
  const views = Array.isArray(spec.view) ? spec.view : [spec.view];
  if (!views.some(v => canView(user, v))) return { ok: false, error: 'not permitted', status: 403 };
  let ctx;
  try {
    ctx = makeSandbox();   // the captured module API (ctx.store, ctx.saveInvoice, ...)
    ctx.store.data = JSON.parse(JSON.stringify(db.data));
    ctx.dbUsers = db.users || [];
    ctx.ensureCOA();
    ctx.ensureStockBaseline();
    /* A nonFinancial op may change ONLY its allowlisted collections and
       meta counters. Everything else (money, stock, books, every other
       module, users' settings) must be byte-identical afterwards or the op
       is rejected and nothing is committed (ctx works on a deep copy). */
    const NF_COLL = ['quality_checks', 'documents'];
    const NF_META = ['qcSeq', 'docSeq', 'nextId']; // nextId: row-id counter used by store.add
    const snap = () => {
      const d = ctx.store.data;
      const rest = {};
      for (const k of Object.keys(d)) if (k !== 'meta' && !NF_COLL.includes(k)) rest[k] = d[k];
      const meta = {};
      for (const k of Object.keys(d.meta || {})) if (!NF_META.includes(k)) meta[k] = d.meta[k];
      return JSON.stringify([rest, meta]);
    };
    const before = spec.nonFinancial ? snap() : null;
    const result = spec.run(ctx, payload || {}, user);
    if (before !== null && snap() !== before) return { ok: false, error: 'operation changed data outside its allowed collections' };
    /* independent integrity gate on the resulting books. A nonFinancial op
       (quality, document register) is exempt ONLY when it left every
       books/stock collection byte-identical, so a pre-existing
       reconciliation issue does not freeze unrelated work, and such an op
       can never be used to slip a posting past the gate. */
    const untouched = before !== null && snap() === before;
    const acc = untouched ? [] : ctx.accountingInvariants();
    const stk = untouched ? [] : ctx.stockInvariants();
    if (acc.length || stk.length) {
      /* name the unresolved reconciliation clearly — dependent financial
         postings stay blocked until an admin resolves it */
      const vs = [...acc, ...stk];
      return { ok: false, error: `Unreconciled books — admin review required: ${vs[0]}`, violations: vs };
    }
    /* commit: server-owned collections and protected fields come ONLY from
       the sandbox result */
    db.data = ctx.store.data;
    return { ok: true, result };
  } catch (e) {
    if (e && e.txError) return { ok: false, error: e.message };
    console.error('tx failure', op, e);
    return { ok: false, error: 'transaction failed' };
  }
}

/* Fill missing standard chart-of-accounts rows on an existing store at
   load time (schema addition only — no journal, no postings). */
function ensureCOAOnData(data) {
  const ctx = makeSandbox();
  ctx.store.data = data;
  ctx.ensureCOA();
  return data;
}

module.exports = { runTx, SERVER_OWNED, OPS, ensureCOAOnData };
