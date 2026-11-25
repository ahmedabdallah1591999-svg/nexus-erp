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
const SERVER_OWNED = new Set(['accounts', 'journal', 'payments', 'warehouses', 'stock_moves',
  'ledger', 'invoices', 'purchases', 'quotes', 'products', 'sales_orders', 'returns', 'recurring', 'expenses', 'projects', 'timesheets',
  'tickets', 'ticket_replies', 'leave_requests', 'attendance', 'assets', 'pos_shifts', 'production', 'quality_checks', 'documents']);

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
    advanceDate, accumDepr, accountCode,
  })`, sandbox);
  return api;
}

/* ---------------- operation handlers ----------------
   Each receives (ctx, payload) where ctx is the sandbox with store.data set
   from the live db. Handlers return a result object or throw a TxError. */

class TxError extends Error {
  constructor(msg) { super(msg); this.txError = true; }
}

function need(cond, msg) { if (!cond) throw new TxError(msg); }

function validItems(items, S) {
  need(Array.isArray(items) && items.length > 0, 'items required');
  for (const it of items) {
    need(Number(it.qty) > 0, 'qty must be positive');
    need(Number(it.price != null ? it.price : it.cost) >= 0, 'price must not be negative');
    /* a line that names a product must name a real one — otherwise stock
       side effects would silently no-op while flags say they happened */
    if (it.product_id != null) {
      need(S.data.products.some(x => x.id === Number(it.product_id)), 'unknown product in line items');
      it.product_id = Number(it.product_id);
    }
  }
}

const OPS = {
  'invoice-save': {
    view: 'invoices',
    run(ctx, p) {
      const out = p.out || {};
      need(['draft', 'sent', 'paid'].includes(out.status), 'bad status');
      const S = ctx.store;
      validItems(out.items, S);
      need(ctx.num(out.tax_rate) >= 0 && ctx.num(out.tax_rate) <= 100, 'bad tax rate');
      let existing = null;
      if (p.id != null) {
        existing = S.data.invoices.find(i => i.id === Number(p.id));
        need(existing, 'invoice not found');
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
      S.remove('invoices', inv.id);
      return { deleted: inv.id };
    },
  },

  'quote-save': {
    view: 'quotes',
    run(ctx, p) {
      const out = p.out || {};
      need(['draft', 'sent', 'accepted', 'rejected'].includes(out.status), 'bad status');
      const S = ctx.store;
      validItems(out.items, S);
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
      const e = ctx.reverseJournal(src.id);
      need(e, 'reversal failed');
      return { entry: e, reverses: src.id };
    },
  },

  'stock-adjust': {
    view: 'stock',
    run(ctx, p) {
      need(Number(p.qty) !== 0, 'qty must not be zero');
      const row = ctx.adjustStock(Number(p.product_id), Number(p.warehouse_id) || null, ctx.num(p.qty), p.memo || '');
      need(row, 'adjustment rejected');
      return { move: row };
    },
  },

  'stock-transfer': {
    view: 'stock',
    run(ctx, p) {
      need(Number(p.qty) > 0, 'qty must be positive');
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
      need(Number(p.amount) > 0, 'amount must be positive');
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
      need(hours > 0, 'hours must be positive');
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
      need(amount > 0, 'amount must be positive');
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
    run(ctx, p) {
      const S = ctx.store;
      const m = String(p.month || ctx.monthStr());
      const already = S.data.ledger.some(l => l.type === 'expense' && l.category === 'Payroll' && (l.date || '').startsWith(m));
      need(!already, 'payroll for this month is already posted');
      const active = S.data.employees.filter(e => e.status === 'active');
      need(active.length, 'no active employees');
      const total = active.reduce((s, e) => s + ctx.num(e.salary), 0);
      active.forEach(e => {
        S.add('ledger', { date: ctx.todayStr(), type: 'expense', category: 'Payroll', amount: ctx.num(e.salary), ref_type: 'payroll', ref_id: e.id, memo: `Salary ${m} - ${e.name}` });
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
      const out = p.out || {};
      need(['draft', 'ordered', 'received'].includes(out.status), 'bad status');
      const S = ctx.store;
      validItems(out.items, S);
      let rec = null;
      if (p.id != null) {
        rec = S.data.purchases.find(x => x.id === Number(p.id));
        need(rec, 'purchase not found');
        Object.assign(rec, out);
      } else {
        out.number = `PO-${String(S.data.meta.purchaseSeq).padStart(4, '0')}`;
        S.data.meta.purchaseSeq++;
        out.stock_applied = false;
        out.ledger_posted = false;
        rec = S.add('purchases', out);
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

  'purchase-delete': {
    view: 'purchases',
    run(ctx, p) {
      const S = ctx.store;
      const po = S.data.purchases.find(x => x.id === Number(p.id));
      need(po, 'purchase not found');
      need(po.status !== 'received' && !po.journal_received, 'received purchases are accounting history; reverse instead of deleting');
      if (po.stock_applied) ctx.applyStock(po.items.map(it => ({ product_id: it.product_id, qty: it.qty })), -1, { reason: 'purchase-delete', ref_type: 'purchase', ref_id: po.id });
      S.remove('purchases', po.id);
      return { deleted: po.id };
    },
  },

  'product-save': {
    view: 'products',
    run(ctx, p) {
      const out = p.out || {};
      need(String(out.name || '').trim(), 'name required');
      need(ctx.num(out.price) >= 0 && ctx.num(out.cost) >= 0, 'prices must not be negative');
      const S = ctx.store;
      let prod;
      if (p.id != null) {
        prod = S.data.products.find(x => x.id === Number(p.id));
        need(prod, 'product not found');
        const stock = prod.stock;            // stock is server-owned
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
      const out = p.out || {};
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
        need(q > 0, 'component quantity must be positive');
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
      need(qty > 0, 'quantity must be positive');
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
      const out = p.out || {};
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
      const today = /^\d{4}-\d{2}-\d{2}$/.test(p.today || '') ? p.today : ctx.todayStr();
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
  'return-create': {
    view: 'orders',
    run(ctx, p) {
      const S = ctx.store;
      const o = S.data.sales_orders.find(x => x.id === Number(p.id));
      need(o, 'order not found');
      need(o.status === 'fulfilled', 'only fulfilled orders can be returned');
      need(Array.isArray(p.items) && p.items.length > 0, 'items required');
      for (const it of p.items) {
        need(ctx.num(it.qty) > 0, 'qty must be positive');
        if (it.product_id != null) need(S.data.products.some(x => x.id === Number(it.product_id)), 'unknown product in return');
        const sold = (o.items || []).filter(x => x.product_id === it.product_id).reduce((s, x) => s + ctx.num(x.qty), 0);
        const back = ctx.returnedQty(o.id, it.product_id);
        need(ctx.num(it.qty) <= sold - back + 0.0005, `return qty exceeds sold quantity for product ${it.product_id}`);
      }
      const row = ctx.applyReturnEffects(o, p.items);
      return { return: row };
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
      const inspected = Number(out.qty_inspected);
      need(Number.isFinite(inspected) && inspected > 0, 'inspected quantity must be positive');
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
      const failed = p.result === 'fail' ? Number(p.qty_failed) : 0;
      if (p.result === 'fail') need(Number.isFinite(failed) && failed > 0 && failed <= q.qty_inspected, 'failed quantity must be between 1 and the inspected quantity');
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
      need(user.role === 'admin' || (q.created_by === user.username && q.result === 'pending'), 'only admin can delete an inspected record');
      S.data.quality_checks = S.data.quality_checks.filter(x => x.id !== q.id);
      S.save();
      return { deleted: q.id };
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
        need(d.status !== 'approved', 'an approved document is locked: revise it to change it');
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
      need(user.role === 'admin' || (d.owner === user.username && d.status === 'draft'), 'only admin can delete a document beyond draft');
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
      need(cost > 0, 'cost must be positive');
      need(salvage >= 0 && salvage < cost, 'salvage must be below cost');
      need(life >= 1 && life <= 600, 'useful life must be 1-600 months');
      need(/^\d{4}-\d{2}-\d{2}$/.test(out.purchase_date || ''), 'purchase date required');
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
      need(/^\d{4}-\d{2}$/.test(p.month || ''), 'month required (YYYY-MM)');
      const month = p.month;
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
      need(/^\d{4}-\d{2}-\d{2}$/.test(p.date || ''), 'disposal date required');
      const proceeds = Math.round(ctx.num(p.proceeds) * 100) / 100;
      need(proceeds >= 0, 'proceeds must not be negative');
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
      need(/^\d{4}-\d{2}-\d{2}$/.test(p.date || ''), 'recognition date required');
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
      const taxRate = p.tax_rate != null ? ctx.num(p.tax_rate) : ctx.num(S.data.settings && S.data.settings.tax_rate);
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
    const BOOK_KEYS = ['journal', 'ledger', 'stock_moves', 'products', 'accounts', 'invoices', 'purchases', 'payments', 'warehouses', 'expenses', 'assets', 'recurring', 'sales_orders', 'returns', 'production', 'pos_shifts'];
    const snap = () => JSON.stringify(BOOK_KEYS.map(k => ctx.store.data[k]));
    const before = spec.nonFinancial ? snap() : null;
    const result = spec.run(ctx, payload || {}, user);
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
