# Nexus ERP

A complete, integrated **ERP + CRM system** that runs entirely in the browser.
No backend, no build step, no dependencies — open it and work.

**Live app:** open `index.html` (or see *Run it* below).

---

## Modules

| Area | What it does |
| --- | --- |
| **Dashboard** | Business at a glance: pipeline value, outstanding invoices, monthly net, open tasks, low-stock alerts, recent activity |
| **CRM — Contacts** | People with company links, status (lead/active/inactive), tags, notes, activity log |
| **CRM — Companies** | Accounts with contact info, linked people count, open pipeline value |
| **CRM — Deals** | Kanban pipeline (Lead → Qualified → Proposal → Negotiation → Won/Lost) with drag-and-drop stage changes |
| **CRM — Tasks** | Follow-ups grouped by Overdue / Today / Upcoming / Completed, priorities, links to contacts and deals |
| **Invoices** | Line-item invoices with tax, auto numbering, customer pulled from the CRM, stock deduction, one-click "mark paid" that posts income to Finance |
| **Inventory** | Products with SKU, price/cost, stock on hand, reorder levels and low-stock flags |
| **Purchases** | Purchase orders to suppliers; receiving restocks inventory and posts the expense |
| **Suppliers** | Supplier directory with open-PO counts |
| **Finance** | Income/expense ledger with monthly totals; invoice payments, received purchases and payroll post here automatically |
| **Employees** | Staff records with salary; one-click monthly payroll run (duplicate-safe) |
| **Reports** | Sales by month, deal pipeline, top products by units sold, expenses by category, win rate, stock value |

Everything is connected: an invoice draws on CRM contacts and inventory items,
its payment lands in the finance ledger, and the dashboard aggregates all of it.

## Languages

The full UI ships in **English, العربية (with RTL layout) and Deutsch** —
switch from the language buttons at the bottom of the sidebar.
Your choice is remembered.

## Run it

The app is 100% static. Any of these work:

1. **GitHub Pages / any static host** — deploy this folder, open the URL.
2. **Locally with one command** (requires [Node.js](https://nodejs.org) 18+):
   ```bash
   node serve.js
   # → http://localhost:3000
   ```
3. **Just open the file** — double-click `index.html`.

## Data & privacy

- All data lives in your browser's `localStorage` — nothing leaves your device.
- **Export data** downloads everything as JSON (backup / move to another device).
- **Import** restores a previous export.
- To reset to the demo data, clear the site data for the page (or the
  `nexus-erp-v1` localStorage key).

## Project structure

```
index.html    App shell (sidebar, topbar, modal, views)
styles.css    Theme, layout, kanban, RTL support
i18n.js       English / Arabic / German dictionaries + language switcher
core.js       Data layer (localStorage), helpers, modal, search, router
seed.js       Demo dataset (loaded on first run only)
crm.js        Contacts, companies, deals, tasks
sales.js      Invoices, products/inventory, purchases, suppliers
finance.js    Ledger, employees/payroll, reports
dashboard.js  Overview view
boot.js       Startup
serve.js      Optional one-command local server
```

## Tech notes

- Vanilla HTML/CSS/JS, zero dependencies, no build step.
- Renders each view in a single pass; safe for thousands of records.
- All user input is escaped before rendering.
- Storage writes are failure-safe (quota errors surface a warning instead of
  losing the UI state).
