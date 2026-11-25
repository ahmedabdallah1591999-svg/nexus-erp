# أحمد عبدالله بيزنس ديفيلوبمنت — Nexus ERP

A complete, integrated **ERP + CRM system** that runs entirely in the browser.
No backend, no build step — open it and work. Data is stored in the browser.

**Live app:** https://ahmedabdallah1591999-svg.github.io/nexus-erp/

---

## Modules

| Area | What it does |
| --- | --- |
| **Dashboard** | Business at a glance: pipeline value, outstanding invoices, monthly net, open tasks, low-stock alerts, recent activity |
| **Notes** | General team notes with pinning — جديد |
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
| **Contact us** | A written message form — messages land in the admin's **Inbox** — جديد |
| **Users & access** | Username/password sign-in with per-section permissions per employee — جديد |
| **Excel export** | Every module exported to one `.xlsx` file, with a summary sheet and a charts sheet (embedded chart images) — جديد |
| **Google Drive export** | Send the same Excel file straight to Google Drive (one-time setup, see below) — جديد |

## Sign-in & access control — جديد

- First run asks you to **create the admin account** with your own username and
  password. There are no default or shared credentials.
- The admin can create employee accounts from **🔑 Users**, choose which sections
  each employee can open, and reset passwords.
- Employees see only their allowed sections; the sidebar, search and direct links
  all respect the permissions.
- Export (Excel / Drive / JSON) and import are admin-only.
- Messages sent through **Contact us** are readable only by the admin (📥 Inbox).

**Honest scope:** this access control runs inside the browser on each device.
It keeps casual users out of sections they should not see, but the data file is
still local — it is not server-side security. Real multi-user security needs a
server database.

## Excel export with charts — جديد

**📊 Export to Excel** downloads one workbook containing every module as a sheet,
a **Summary** sheet with the key numbers, a **ChartData** sheet, and a **Charts**
sheet with native, editable Excel charts (sales by month, expenses by category,
pipeline, top products) bound to the ChartData ranges — edit values or restyle
them like any chart you made in Excel yourself. The file is built entirely in
the browser (via JSZip, vendored in `vendor/`) — no server, nothing uploaded.

## Google Drive export — one-time setup

The app needs a Google OAuth **Client ID** to upload to Drive:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project,
   enable the **Google Drive API**.
2. Create an **OAuth client ID** (type: Web application) and add
   `https://ahmedabdallah1591999-svg.github.io` as an authorized JavaScript origin.
3. Copy the client ID (`….apps.googleusercontent.com`).
4. In the app, sign in as admin → **☁️ Export to Google Drive** → paste the
   client ID once. After that, the button uploads the Excel file to your Drive
   (you pick the Google account in Google's own popup; scope: `drive.file`).

## Languages

The full UI ships in **English, العربية (with RTL layout) and Deutsch** —
switch from the language buttons. Your choice is remembered.

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

- All business data lives in the browser's `localStorage` — nothing leaves the device.
- Accounts (usernames + salted password hashes) live in a separate localStorage key.
- **Export data** downloads everything as JSON (backup / move to another device).
- **Import** restores a previous export (admin only).
- The first run includes demo data so every screen has something to show;
  delete the demo rows from inside the app as you replace them with real data.

## Project structure

```
index.html        App shell (sidebar, topbar, modal, views, sign-in screen)
styles.css        Theme, layout, kanban, RTL support, new components
i18n.js           English / Arabic / German dictionaries
i18n-extra.js     Translations for the new modules
core.js           Data layer, helpers, modal, search, router (with access guard)
seed.js           Demo data (first run only)
crm.js            Contacts, companies, deals, tasks
sales.js          Products, suppliers, invoices, purchases
finance.js        Ledger, employees/payroll, reports
dashboard.js      Overview
auth.js           Sign-in, accounts, per-section permissions
extras.js         Notes, Contact us, admin Inbox
export.js         Excel (.xlsx) builder with embedded charts + Google Drive upload
vendor/jszip.min.js  JSZip (MIT) — the only vendored library, used for .xlsx
serve.js          Optional local server
boot.js           Startup
```
