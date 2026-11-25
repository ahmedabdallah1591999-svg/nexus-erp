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
