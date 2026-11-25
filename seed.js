'use strict';
/* seed.js — realistic demo data, loaded the first time the app runs.
   Delete the browser's localStorage key to reseed. */

function seedData() {
  const d = emptyData();
  /* marks this exact fixture as the known synthetic seed — the only case
     where opening stock values are established automatically */
  d.settings = { seed_demo: true };
  const add = (coll, row) => { row.id = d.meta.nextId++; d[coll].push(row); return row.id; };
  const today = new Date();
  const iso = offset => { const t = new Date(today); t.setDate(t.getDate() + offset); return t.toISOString().slice(0, 10); };
  const ts = offset => { const t = new Date(today); t.setDate(t.getDate() + offset); return t.toISOString(); };

  /* Companies & contacts (CRM) */
  const c1 = add('companies', { name: 'Nile Trading Co.', industry: 'Import & Export', website: 'https://niletrading.example.com', phone: '+20 100 555 0141', email: 'info@niletrading.example.com', address: 'Downtown, Cairo', notes: 'Long-standing wholesale client.', created_at: ts(-40) });
  const c2 = add('companies', { name: 'Delta Foods', industry: 'Food & Beverage', website: '', phone: '+20 122 555 0193', email: 'contact@deltafoods.example.com', address: 'Mansoura, Dakahlia', notes: '', created_at: ts(-32) });
  const c3 = add('companies', { name: 'Cairo Tech Solutions', industry: 'Software', website: 'https://cairotech.example.com', phone: '', email: 'hello@cairotech.example.com', address: 'Maadi, Cairo', notes: 'Referred by Karim.', created_at: ts(-21) });
  add('companies', { name: 'Red Sea Resorts', industry: 'Hospitality', website: '', phone: '+20 65 555 0110', email: '', address: 'Hurghada', notes: '', created_at: ts(-12) });

  const p1 = add('contacts', { first_name: 'Mona', last_name: 'El-Sayed', email: 'mona@niletrading.example.com', phone: '+20 100 555 0141', position: 'Procurement Manager', company_id: c1, status: 'active', tags: 'wholesale,vip', notes: 'Prefers WhatsApp follow-ups.', created_at: ts(-38) });
  const p2 = add('contacts', { first_name: 'Karim', last_name: 'Hassan', email: 'karim@cairotech.example.com', phone: '+20 111 555 0177', position: 'CEO', company_id: c3, status: 'active', tags: 'referral', notes: '', created_at: ts(-21) });
  const p3 = add('contacts', { first_name: 'Sara', last_name: 'Mostafa', email: 'sara@deltafoods.example.com', phone: '+20 122 555 0193', position: 'Finance Lead', company_id: c2, status: 'lead', tags: '', notes: 'Met at the food expo.', created_at: ts(-14) });
  const p4 = add('contacts', { first_name: 'Omar', last_name: 'Fathy', email: '', phone: '+20 106 555 0120', position: 'Owner', company_id: c2, status: 'lead', tags: 'expo', notes: '', created_at: ts(-9) });
  add('contacts', { first_name: 'Layla', last_name: 'Nasser', email: 'layla.nasser@example.com', phone: '', position: '', company_id: null, status: 'inactive', tags: '', notes: 'Old retail contact.', created_at: ts(-60) });

  /* Deals pipeline */
  const dl1 = add('deals', { title: 'Wholesale supply contract', value: 18000, stage: 'Negotiation', contact_id: p1, company_id: c1, expected_close: iso(10), notes: 'Waiting on legal review.', created_at: ts(-20), updated_at: ts(-2) });
  const dl2 = add('deals', { title: 'Inventory software rollout', value: 9500, stage: 'Proposal', contact_id: p2, company_id: c3, expected_close: iso(21), notes: 'Sent proposal v2.', created_at: ts(-15), updated_at: ts(-3) });
  const dl3 = add('deals', { title: 'Catering equipment lease', value: 4200, stage: 'Qualified', contact_id: p3, company_id: c2, expected_close: iso(30), notes: '', created_at: ts(-11), updated_at: ts(-5) });
  add('deals', { title: 'POS terminals - 12 branches', value: 26000, stage: 'Lead', contact_id: p4, company_id: c2, expected_close: iso(45), notes: 'First call done.', created_at: ts(-8), updated_at: ts(-8) });
  add('deals', { title: 'Annual maintenance renewal', value: 3000, stage: 'Won', contact_id: p1, company_id: c1, expected_close: iso(-6), notes: '', created_at: ts(-30), updated_at: ts(-6) });
  add('deals', { title: 'Website redesign', value: 5500, stage: 'Lost', contact_id: p2, company_id: c3, expected_close: iso(-15), notes: 'Chose a cheaper agency.', created_at: ts(-35), updated_at: ts(-15) });

  /* Tasks */
  add('tasks', { title: 'Send revised contract to Mona', description: 'Incorporate the payment-terms change she asked for.', due_date: iso(0), priority: 'high', done: 0, contact_id: p1, deal_id: dl1, created_at: ts(-2) });
  add('tasks', { title: 'Follow up with Sara on quote', description: '', due_date: iso(1), priority: 'medium', done: 0, contact_id: p3, deal_id: dl3, created_at: ts(-3) });
  add('tasks', { title: 'Prepare demo for Cairo Tech', description: 'Focus on reporting module.', due_date: iso(4), priority: 'medium', done: 0, contact_id: p2, deal_id: dl2, created_at: ts(-1) });
  add('tasks', { title: 'Update price list', description: 'Add Q1 prices before sharing with leads.', due_date: iso(-1), priority: 'low', done: 0, contact_id: null, deal_id: null, created_at: ts(-4) });
  add('tasks', { title: 'Thank-you call to Karim for referral', description: '', due_date: iso(-2), priority: 'low', done: 1, contact_id: p2, deal_id: null, created_at: ts(-5) });

  /* Activity log */
  add('activities', { type: 'call', subject: 'Call with Mona', body: 'Agreed on revised payment terms; contract update pending.', contact_id: p1, deal_id: dl1, created_at: ts(-2) });
  add('activities', { type: 'email', subject: 'Proposal v2 sent', body: 'Sent updated proposal for the software rollout.', contact_id: p2, deal_id: dl2, created_at: ts(-3) });
  add('activities', { type: 'meeting', subject: 'Expo intro meeting', body: 'Met Sara and Omar; they asked for a quote.', contact_id: p3, deal_id: dl3, created_at: ts(-9) });

  /* Products & inventory */
  const pr1 = add('products', { name: 'Barcode Scanner BS-220', sku: 'BS-220', category: 'Hardware', price: 145, cost: 92, stock: 34, reorder_level: 10, created_at: ts(-50) });
  const pr2 = add('products', { name: 'POS Terminal T-900', sku: 'POS-T900', category: 'Hardware', price: 620, cost: 430, stock: 12, reorder_level: 5, created_at: ts(-50) });
  const pr3 = add('products', { name: 'Thermal Receipt Paper (box of 50)', sku: 'TRP-50', category: 'Consumables', price: 38, cost: 21, stock: 120, reorder_level: 40, created_at: ts(-45) });
  const pr4 = add('products', { name: 'Inventory Software License (annual)', sku: 'SW-INV-1Y', category: 'Software', price: 480, cost: 0, stock: 999, reorder_level: 0, created_at: ts(-45) });
  const pr5 = add('products', { name: 'Cash Drawer CD-16', sku: 'CD-16', category: 'Hardware', price: 89, cost: 55, stock: 6, reorder_level: 8, created_at: ts(-40) });

  /* Suppliers */
  const s1 = add('suppliers', { name: 'Shenzhen Bright Electronics', contact_person: 'Wei Chen', email: 'sales@brightelec.example.com', phone: '+86 755 555 0100', address: 'Shenzhen, China', notes: 'Hardware supplier, 30-day terms.', created_at: ts(-50) });
  const s2 = add('suppliers', { name: 'Alex Paper Mills', contact_person: 'Hoda Samir', email: 'orders@alexpaper.example.com', phone: '+20 3 555 0188', address: 'Alexandria', notes: '', created_at: ts(-44) });

  /* Invoices (items are embedded line rows) */
  const inv1 = add('invoices', {
    number: 'INV-0001', contact_id: p1, deal_id: dl1, status: 'paid',
    issue_date: iso(-18), due_date: iso(-4), tax_rate: 14,
    items: [
      { product_id: pr2, description: 'POS Terminal T-900', qty: 10, price: 620 },
      { product_id: pr1, description: 'Barcode Scanner BS-220', qty: 10, price: 145 },
    ],
    notes: 'First phase of the wholesale contract.', stock_applied: true, created_at: ts(-18),
  });
  d.meta.invoiceSeq = 2;
  const inv2 = add('invoices', {
    number: 'INV-0002', contact_id: p2, deal_id: dl2, status: 'sent',
    issue_date: iso(-5), due_date: iso(9), tax_rate: 14,
    items: [
      { product_id: pr4, description: 'Inventory Software License (annual)', qty: 15, price: 480 },
    ],
    notes: '', stock_applied: true, created_at: ts(-5),
  });
  d.meta.invoiceSeq = 3;
  add('invoices', {
    number: 'INV-0003', contact_id: p3, deal_id: null, status: 'draft',
    issue_date: iso(0), due_date: iso(14), tax_rate: 14,
    items: [
      { product_id: pr3, description: 'Thermal Receipt Paper (box of 50)', qty: 20, price: 38 },
      { product_id: pr5, description: 'Cash Drawer CD-16', qty: 4, price: 89 },
    ],
    notes: 'Draft - waiting for Sara to confirm quantities.', stock_applied: false, created_at: ts(0),
  });
  d.meta.invoiceSeq = 4;

  /* Purchase orders */
  add('purchases', {
    number: 'PO-0001', supplier_id: s1, status: 'received', order_date: iso(-25), received_date: iso(-10),
    items: [{ product_id: pr2, qty: 15, cost: 430 }, { product_id: pr1, qty: 40, cost: 92 }],
    notes: '', stock_applied: true, created_at: ts(-25),
  });
  d.meta.purchaseSeq = 2;
  add('purchases', {
    number: 'PO-0002', supplier_id: s2, status: 'ordered', order_date: iso(-3), received_date: '',
    items: [{ product_id: pr3, qty: 100, cost: 21 }],
    notes: 'Expected within two weeks.', stock_applied: false, created_at: ts(-3),
  });
  d.meta.purchaseSeq = 3;

  /* Finance ledger */
  add('ledger', { date: iso(-4), type: 'income', category: 'Sales', amount: 8721, ref_type: 'invoice', ref_id: inv1, memo: 'Payment received for INV-0001', created_at: ts(-4) });
  add('ledger', { date: iso(-12), type: 'expense', category: 'Purchases', amount: 10130, ref_type: 'purchase', ref_id: null, memo: 'PO-0001 payment - Shenzhen Bright Electronics', created_at: ts(-12) });
  add('ledger', { date: iso(-8), type: 'expense', category: 'Rent', amount: 1200, ref_type: null, ref_id: null, memo: 'Office rent', created_at: ts(-8) });
  add('ledger', { date: iso(-30), type: 'expense', category: 'Payroll', amount: 3900, ref_type: null, ref_id: null, memo: 'Payroll - previous month', created_at: ts(-30) });

  /* Employees */
  add('employees', { name: 'Ahmed Abdallah', position: 'Sales & Operations Manager', department: 'Sales', email: '', phone: '', salary: 1500, hire_date: iso(-400), status: 'active', created_at: ts(-400) });
  add('employees', { name: 'Nour Adel', position: 'Accountant', department: 'Finance', email: '', phone: '+20 100 555 0132', salary: 1200, hire_date: iso(-300), status: 'active', created_at: ts(-300) });
  add('employees', { name: 'Mahmoud Said', position: 'Warehouse Keeper', department: 'Inventory', email: '', phone: '+20 111 555 0154', salary: 1200, hire_date: iso(-200), status: 'active', created_at: ts(-200) });

  return d;
}
