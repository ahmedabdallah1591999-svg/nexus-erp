Test scripts (not shipped in the user ZIP). Expect the repo at /tmp/nexus-erp. Run each suite alone, sequentially.
- matrix-test.py (run with NEXUS_TEST_* env vars UNSET), pkg/quality/purchase/forge/corr-test.sh: self-contained.
- legacy-test.py: needs `git worktree add /tmp/legacy-app 0cf5580` (the hotfix8 code), builds a real legacy store and upgrades it.
- sc-flow.sh + flow-shot.js: UI flow through a headless Chrome (supplier credit return, apply, screenshots into /downloads).
- preserve-test.sh, ca-test.sh, mig-battery.sh: need fixture files that are NOT in this repo (see COVERAGE.md). They fail without them; that is not a code result.
- cash-test.py + cash-eval.js (cash classification, page code in headless Chrome), mig-test.py (inventory adjustment migration): self-contained reconstructions, see COVERAGE.md for the mapping and what is not covered.
- close-test.py: payroll cash behavior, legacy-shaped POS refunds, purchase-adjustment presentation. See COVERAGE.md.
