# Server route coverage map (hotfix4 working tree)

Every op below runs only through POST /api/tx on the local server (server.js). Server mode checks: session identity, module permission (`view`), server-owned collections written only from the sandboxed transaction, accounting/stock invariants checked before commit, one-at-a-time execution.

Automated adversarial coverage (`matrix-test.py`, 35 checks): P1 a user with no modules gets 403 on all 71 ops; P2 an invoices-only user is refused outside its view; M1-M6 junk payloads (31 shapes incl. Infinity, wrong types, huge arrays) on every op give no 5xx, no data change on a rejected request, invariants hold, no unexpected exception; malformed JSON gives 400; forged PUT meta counters ignored; POS tax from settings only; concurrency: payment, POS same ref, pos-refund, quote-convert, purchase-return, order-fulfill, order return, credit note on refunded POS sale; revalue guards (admin, reason, reviewed amount, concurrency, journal, invariants).

Dedicated suites: corr-test (returns/credit notes/refund confirmation), forge-test (forged prices/fields), purchase-test, quality-test, ca-test, preserve-test (no data reset), pkg-test, migration battery.

| Op | Required module | Notes |
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

## Not hardened / unsupported (stated honestly)
- Local single-user browser mode is client-authoritative: the browser can edit its own data. The guards above apply to server mode only.
- Not supported and blocked or absent: partial receipts, void of a credit note or return, credit balances / store credit (unpaid over-credit and unconfirmed refunds are blocked, never turned into cash movement), multi-level BOM, multi-currency, multi-company, bank reconciliation, e-sign, hosted files, Egypt ETA e-invoicing.
- Old returns recorded before the price/refund fixes are kept as-is and shown as "Needs review" (price differs from order line, returned more than sold, money paid back without confirmation). No corrective entries are invented.
- Not yet individually reviewed by hand, only fuzz/permission-tested: timesheet-invoice, expense-*, payroll, asset-*, produce/bom-save, recurring-run, leave/attendance, ticket-*, qc/doc.
- No production, Windows, or financial-readiness claim. Synthetic-data local trial only.
