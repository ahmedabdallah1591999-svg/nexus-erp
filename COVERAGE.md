# Server route coverage map (hotfix4 working tree)

Every op below runs only through POST /api/tx on the local server (server.js). Server mode checks: session identity, module permission (`view`), server-owned collections written only from the sandboxed transaction, accounting/stock invariants checked before commit, one-at-a-time execution.

Automated adversarial coverage (`matrix-test.py`, 35 checks): P1 a user with no modules gets 403 on all 71 ops; P2 an invoices-only user is refused outside its view; M1-M6 junk payloads (31 shapes incl. Infinity, wrong types, huge arrays) on every op give no 5xx, no data change on a rejected request, invariants hold, no unexpected exception; malformed JSON gives 400; forged PUT meta counters ignored; POS tax from settings only; concurrency: payment, POS same ref, pos-refund, quote-convert, purchase-return, order-fulfill, order return, credit note on refunded POS sale; revalue guards (admin, reason, reviewed amount, concurrency, journal, invariants).

Dedicated suites: corr-test (returns/credit notes/refund confirmation), forge-test (forged prices/fields), purchase-test, quality-test, ca-test, preserve-test (no data reset), pkg-test, migration battery.

| Op | Required module | Notes (write-authority rules are in the op code; module view alone is not approval authority for payroll, reversal of postings, revaluation, recognition) |
|---|---|---|
| invoice-save | invoices | fuzzed in matrix; 403 without module |
| invoice-delete | invoices | fuzzed in matrix; 403 without module |
| quote-save | quotes | fuzzed in matrix; 403 without module |
| quote-convert | quotes | fuzzed in matrix; 403 without module |
| quote-delete | quotes | fuzzed in matrix; 403 without module |
| payment | payments | fuzzed in matrix; 403 without module |
| journal | accounting | fuzzed in matrix; 403 without module |
| journal-reverse | accounting | fuzzed in matrix; 403 without module |
| stock-adjust | stock | fuzzed in matrix; 403 without module |
| stock-transfer | stock | fuzzed in matrix; 403 without module |
| warehouse-add | stock | fuzzed in matrix; 403 without module |
| ledger-entry | finance | fuzzed in matrix; 403 without module |
| project-save | projects | fuzzed in matrix; 403 without module |
| project-delete | projects | fuzzed in matrix; 403 without module |
| timesheet-save | projects | fuzzed in matrix; 403 without module |
| timesheet-delete | projects | fuzzed in matrix; 403 without module |
| timesheet-invoice | projects | fuzzed in matrix; 403 without module |
| expense-approve | finance | fuzzed in matrix; 403 without module |
| expense-reject | finance | fuzzed in matrix; 403 without module |
| payroll | finance | fuzzed in matrix; 403 without module |
| purchase-save | purchases | fuzzed in matrix; 403 without module |
| purchase-delete | purchases | fuzzed in matrix; 403 without module |
| product-save | products | fuzzed in matrix; 403 without module |
| product-revalue | products | fuzzed in matrix; 403 without module |
| product-delete | products | fuzzed in matrix; 403 without module |
| order-save | orders | fuzzed in matrix; 403 without module |
| quote-to-order | orders | fuzzed in matrix; 403 without module |
| order-confirm | orders | fuzzed in matrix; 403 without module |
| order-fulfill | orders | fuzzed in matrix; 403 without module |
| order-cancel | orders | fuzzed in matrix; 403 without module |
| order-delete | orders | fuzzed in matrix; 403 without module |
| migrate-inventory | accounting | fuzzed in matrix; 403 without module |
| reclass-settlement | accounting | fuzzed in matrix; 403 without module |
| bom-save | manufacturing | fuzzed in matrix; 403 without module |
| produce | manufacturing | fuzzed in matrix; 403 without module |
| recurring-save | invoices | fuzzed in matrix; 403 without module |
| recurring-status | invoices | fuzzed in matrix; 403 without module |
| recurring-delete | invoices | fuzzed in matrix; 403 without module |
| recurring-run | invoices | fuzzed in matrix; 403 without module |
| credit-note-create | invoices | fuzzed in matrix; 403 without module |
| purchase-return-create | purchases | fuzzed in matrix; 403 without module |
| return-create | orders | fuzzed in matrix; 403 without module |
| ticket-save | helpdesk | fuzzed in matrix; 403 without module |
| ticket-status | helpdesk | fuzzed in matrix; 403 without module |
| ticket-reply | helpdesk | fuzzed in matrix; 403 without module |
| ticket-delete | helpdesk | fuzzed in matrix; 403 without module |
| qc-save | quality | fuzzed in matrix; 403 without module |
| qc-result | quality | fuzzed in matrix; 403 without module |
| qc-close | quality | fuzzed in matrix; 403 without module |
| qc-delete | quality | fuzzed in matrix; 403 without module |
| credit-note-void / purchase-return-void / return-void | invoices / purchases / orders | functional matrix tests (admin-only, reason, concurrency, stock-on-hand, refund rejection, invariants) + fuzz |
| purchase-receipt-void / credit-apply / supplier-credit-apply | purchases / invoices / purchases | functional matrix tests (concurrency, same-customer, caps, stock-on-hand, invariants) + fuzz |
| qc-void | quality | fuzzed in matrix; 403 without module |
| doc-save | quality | fuzzed in matrix; 403 without module |
| doc-status | quality | fuzzed in matrix; 403 without module |
| doc-revise | quality | fuzzed in matrix; 403 without module |
| doc-delete | quality | fuzzed in matrix; 403 without module |
| leave-decide | employees | fuzzed in matrix; 403 without module |
| asset-save | assets | fuzzed in matrix; 403 without module |
| asset-depreciate | assets | fuzzed in matrix; 403 without module |
| asset-dispose | assets | fuzzed in matrix; 403 without module |
| asset-recognize | assets | fuzzed in matrix; 403 without module |
| asset-delete | assets | fuzzed in matrix; 403 without module |
| pos-sale | pos | fuzzed in matrix; 403 without module |
| pos-refund | pos | fuzzed in matrix; 403 without module |
| pos-shift-open | pos | fuzzed in matrix; 403 without module |
| pos-shift-close | pos | fuzzed in matrix; 403 without module |
| attendance-delete | employees or hr-self | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| attendance-save | employees or hr-self | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| expense-delete | finance or expenses | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| expense-save | finance or expenses | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| leave-delete | employees or hr-self | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| leave-save | employees or hr-self | any-of modules (self-service scoped to own record); fuzzed in matrix; 403 without module |
| purchase-receive | purchases | partial receipts: product lines only; qty <= left; client_ref retry dedupe; last receipt takes the rounding remainder; matrix RC1-RC20 |

## Not hardened / unsupported (stated honestly)
- Local single-user browser mode is client-authoritative: the browser can edit its own data. The guards above apply to server mode only.
- Not supported and blocked or absent: void of any document that paid money out (confirmed refunds), cash payout of credits (unconfirmed supplier refunds are blocked, never turned into cash movement), multi-level BOM, multi-currency, multi-company, bank reconciliation, e-sign, hosted files, Egypt ETA e-invoicing.
- Old returns recorded before the price/refund fixes are kept as-is and shown as "Needs review" (price differs from order line, returned more than sold, money paid back without confirmation). No corrective entries are invented.
- Hand-reviewed with happy-path, duplicate, boundary and forged-valid-value tests (matrix B-section): payroll, journal/reversal, ledger-entry, expenses (submit/approve separation of duties), timesheets and timesheet-invoice, recurring-run, assets (save/depreciate/dispose). Stock adjust/transfer and manufacturing (bom-save single-level both ways, produce incl. retries and concurrency) are now hand-reviewed and tested. POS shifts (bounds, one open shift, close rules, closed shift takes no sale), quality (a recorded failure cannot be flipped to pass) and document control (edit only in draft, owner cannot approve) are hand-reviewed and tested. Tickets and warehouse-add are only fuzz and permission tested (shared helpdesk queue by design; any helpdesk user may work any ticket).
- Valuation: stock revaluation AND write-down are BLOCKED (product-revalue returns a clear rejection; no UI button). Reason: overwriting unit cost would lose the acquisition cost used by returns, COGS and production, and there is no valuation-allowance account. A cost change on stock on hand is rejected with the same wording; damaged/lost stock is recorded with a stock adjustment (reason required, cannot go below zero). Nothing here is called IAS 2 supported.
- No production, Windows, or financial-readiness claim. Synthetic-data local trial only.

- Manufacturing posts finished goods at the product's stated cost and the difference to Manufacturing Variance 5200 (standard-cost style); if a finished product has cost 0 the component cost goes entirely to variance. Single-level BOM only.
- Test-only date seam needs two environment variables set together (never in shipped files; matrix R6 scans for it; R7 proves the production default blocks future periods).
- Partial receipts allocate each line's OWN value (qty x cost to the cent, pro rata by quantity; a line's last receipt takes only that line's own cent remainder; nothing moves between lines). Purchases have no discount or tax fields. A purchase whose line values cannot add up to its total (sub-cent costs) is refused for partial receipt. Returns after full receipt value each returned line at its own line cost (tested with mixed costs).
- Partial receipts (server mode, ordered purchases with product lines only): each receipt posts stock and Dr Inventory / Cr Payables for the received quantities at the PO cost. A partly received purchase cannot be edited (note only), deleted, marked received by save, paid to the supplier, or returned until it is fully received. No receipt void, no over-receipt, no receipts on purchases with non-stock lines, no landed cost.

- Voids (server mode, admin only, reason >=5 chars): credit notes, purchase returns and sales-order returns. The original stays as status void with who/when/why; its journals are reversed line by line at original amounts; stock is taken back only if still on hand; quantities and credited/returned totals are freed. Rejected: documents that paid money out (a confirmed refund), since recording money coming back is not modelled. Old stored data is not rewritten. A void does not re-price stock cost: COGS is reversed at the original journal amount.

- Receipt void (server mode, admin, reason >=5): only the LATEST active receipt of a still-partly-received purchase. Kept as void with who/when/why, journal reversed at the original amount, goods leave stock only if still on hand, received quantities freed. A fully received purchase is corrected by a supplier return, not by a receipt void.
- Customer credit (server mode): when a credit note is more than the customer still owes (they already paid), the user may explicitly choose "keep as customer credit". That posts the excess to a liability account 2150 Customer Credits, no cash or bank moves, and creates a credit record for that customer. `credit-apply` uses it (admin only) against the SAME customer's open posted invoice, through the normal payment path (Dr 2150 / Cr Receivables), never above the credit left or the invoice's open amount. Not supported: automatic application, transfer between customers, cash payout of a credit, expiry. A credit note whose credit has been used cannot be voided; an unused one can. Without the explicit choice the old rule stays: over-credit is blocked unless a refund is confirmed with method and reference. Account 2150 is added to existing books on first use only; no history is rewritten.
- Supplier credit (server mode, hotfix16): when a purchase return is more than we still owe (we already paid the supplier), the user may explicitly choose "keep as a credit with the supplier" (`store_credit: true`). The excess is debited to a new ASSET account 1150 Supplier Credits (money the supplier owes us in goods/credit, not cash); no cash or bank moves and no ledger cash row. A `supplier_credits` record (SC-n) is created. `supplier-credit-apply` (admin only) uses it against the SAME supplier's received purchase with an open balance: Dr Payables 2000 / Cr 1150 through the normal payment path, capped by the credit left and the purchase's open amount. A direct payment with method store_credit is refused. A return whose credit was used cannot be voided; an unused one can (credit becomes void, journal reversed). Not supported: automatic application, transfer between suppliers, cash refund of a credit, expiry, supplier credit shown inside AP aging. Also fixed: `customer_credits` and `supplier_credits` are server-owned (a client PUT of the collection cannot change balances); before this fix customer_credits was writable through the bulk data PUT.
- Supplier-credit accounting basis (secondary sources, not a standard's text, and not reviewed by an accountant): a supplier that owes us money (we paid, then returned goods or overpaid) is a debit balance that is an asset ("receivable from vendor"), not a negative liability: https://simplestudies.com/accounting-for-unusual-account-balances-and-offsetting.html and https://legalclarity.org/can-you-have-a-negative-liability-on-a-balance-sheet/. It is kept in its own account (1150) and shown gross, not netted against payables, because offsetting a financial asset and liability is allowed only with a legally enforceable right of set-off AND an intent to settle net (IAS 32 para 42; see https://www.gov.uk/hmrc-internal-manuals/corporate-finance-manual/cfm21290). The mirror customer credit (2150) is a liability shown gross against receivables. The payments page shows both credit totals separately and states they are not deducted from AR/AP; AP/AR aging stay gross.
- Credit integrity: customer_credits and supplier_credits are server-owned (bulk PUT, full-document import and non-admin PUT cannot change balances, usage history or add credits; legacy-test L8-L10). Every posting runs a reconciliation gate: each credit's remaining must equal amount minus its usage history, and the open totals must equal GL 2150 / 1150; an offline-edited store.json is refused at the next posting (L14). Restore (restore.sh/bat) is an offline file copy that brings back credits with their history together with the books.
- Test status: matrix, pkg, quality, purchase, forge, corr suites run on hotfix16. preserve-test, ca-test and mig-battery need fixture files from an earlier environment (a preserved cumulative store, /tmp/ca-fixture.py, /tmp/ca-eval.js, /tmp/migtest) that are not recoverable; they are NOT reported as passing. legacy-test.py replaces part of that coverage by building a real hotfix8 store (git 0cf5580) and upgrading it; it does not replicate the cash-flow classification (ca) or the inventory-adjustment migration battery.

