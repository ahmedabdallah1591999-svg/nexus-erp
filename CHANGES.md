# Nexus ERP - release notes

## Hotfix 1 (local-test build, Linux-tested only)

Server-side integrity fixes. If you ran an earlier local-test zip and entered real data, keep your data folder as it is and tell us before changing anything.

What was wrong: the server accepted fields it should own. A request could resend a record with posting flags set to false and make the server post it again (stock deducted twice, journals twice), could change lines of an already posted invoice or received purchase order, or could write protected fields (id, number, links, recipe).

What changed:
- Purchase orders: number and posting flags are server-owned. A received purchase order cannot be changed or moved back (only its note can be edited). Unknown supplier is rejected.
- Invoices: number and posting flags are server-owned. A posted (sent or paid) invoice has locked lines, customer, tax and issue date, cannot go back to an earlier status, and keeps editable notes, due date and deal link. Unknown customer is rejected. "Mark paid" now sends the full record.
- Products, quotes, sales orders, recurring templates: only the fields of the form are accepted; ids, numbers, links, recipes and flags are ignored.
- Quality inspections and the document register (metadata only) are included; inspected records can be voided, not deleted.
- Product cost changes while stock is on hand are rejected by the books check (no revaluation flow yet).

Not changed / still open: Windows scripts were reviewed but never run on Windows; multi-currency, multi-company, bank reconciliation, purchase returns and partial receipts are not built.

## Hotfix 2: correction path for posted documents (server mode, Linux-tested only)

- Sales credit note (button on any sent/paid invoice): numbered CN-0001..., credits chosen invoice lines up to what is left, posts its own reversing journal (revenue and tax out, receivable down). Goods go back to stock only if you choose it, with the cost reversal. If the credit is more than the open balance (customer already paid), you must choose the refund method; the refund is then recorded, nothing is assumed. The invoice itself is never edited; its open balance shrinks.
- Purchase return (button on any received purchase): numbered PR-0001..., returns chosen lines up to what is left, takes the stock out, reduces payables. Blocked if the stock was already sold, or if the product cost differs from the purchase line cost. If the supplier was already paid you must choose the refund method received.
- Both are retry-safe (same request twice posts once), reject over-crediting, need a reason, and cannot be forged through the generic data save.
- A fully credited invoice cannot be marked paid. A sales-order return and a credit note on the same invoice are blocked to avoid crediting twice.
- Not built: partial receipts, valuation change with stock on hand, voiding a credit note, supplier credit balances, credit note printing/export.

## Hotfix 3: sales-order returns reconciled, refunds must be confirmed (server mode, Linux-tested only)

- FLAW FIXED (present since before hotfix1): the server priced a sales-order return from the price sent by the browser, so a forged request could return at an inflated price and credit/refund too much. The server now prices returns from the order lines.
- FLAW FIXED: a return on an already-paid invoice posted a cash refund automatically. A refund is now recorded only when the reviewer confirms the money was really paid back (yes/no) and enters a method and a reference. Otherwise the request is blocked with a plain message; nothing is posted. Same rule for credit notes and for supplier refunds on purchase returns. There are no credit balances yet, so unconfirmed over-credit cases are blocked, never posted.
- Sales-order returns now reduce the invoice open amount (before, the journal fell but the invoice still showed the full balance, so payments, aging, dashboard and reports disagreed). Old returns count automatically (derived from stored returns; no data rewritten, no reset).
- Credit notes and sales-order returns on the same invoice are allowed together, capped by the invoiced quantity per product.
- Dashboard, Excel export and finance reports use open amount / net of credits.
- Local single-user browser mode asks for a confirm() before posting a refund of money already paid.

## hotfix4 (working tree)
- Cost change blocked while stock exists (clear message); new admin-only `product-revalue` posts a reviewed Inventory/COGS adjustment with history.
- Line items normalized and bounded (finite qty/price, 500 lines); quote tax 0-100; POS tax comes from settings; pos-refund blocked if credits exist; credit note needs sent/paid.
- PUT /api/data: only meta.nextId accepted from client (document counters are server-owned).
- Journal op rejects non-list lines (was an exception); malformed JSON gives 400 not 500.
- Old returns flagged "Needs review" in the UI; no data rewritten.
- See COVERAGE.md.
- Stock revaluation/write-down blocked entirely (clear message, UI button removed); cost change on stock rejected; stock-adjust write-offs need a reason and cannot go below zero; bom-save blocks multi-level both ways; quantity bounds.
- Payroll admin-only, real month, no future month, duplicate runs for older months now blocked (month marker).
- journal-reverse: only manual entries, once; document postings must be corrected via the document.
- recurring-run date is server-owned (client cannot name a future date); real-calendar date checks on journal, ledger, expense, timesheet, assets; depreciation cannot post for future months; disposal cannot precede purchase or posted depreciation; deleting a draft time invoice releases the time.
- POS shift amounts bounded; a recorded QC failure cannot be flipped to pass; documents editable only in draft.
- hotfix8: browser-only mode warning banner at entry; Arabic install/upgrade instructions in deploy/README-AR.md.
