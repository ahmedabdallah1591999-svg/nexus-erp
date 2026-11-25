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
  'ledger', 'invoices', 'purchases', 'quotes', 'products', 'sales_orders', 'returns', 'recurring']);

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
    advanceDate,
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

  'expense-save': {
    view: 'finance',
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
    view: 'finance',
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
};

/* ---------------- engine ---------------- */

/* Run one transaction against db (mutated in place on success only).
   Returns { ok:true, result } or { ok:false, error, violations? }. */
function runTx(db, user, op, payload, canView) {
  const spec = OPS[op];
  if (!spec) return { ok: false, error: 'unknown operation' };
  if (!canView(user, spec.view)) return { ok: false, error: 'not permitted', status: 403 };
  let ctx;
  try {
    ctx = makeSandbox();   // the captured module API (ctx.store, ctx.saveInvoice, ...)
    ctx.store.data = JSON.parse(JSON.stringify(db.data));
    ctx.ensureCOA();
    ctx.ensureStockBaseline();
    const result = spec.run(ctx, payload || {}, user);
    /* independent integrity gate on the resulting books */
    const acc = ctx.accountingInvariants();
    const stk = ctx.stockInvariants();
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

module.exports = { runTx, SERVER_OWNED, OPS };
