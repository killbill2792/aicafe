# Architecture specifications

Specs are reviewable documentation, not implementation authorization. Status must move through Draft → In Review → Accepted → Implemented; owner approval is required before code, migration, queue activation or merge.

| Number | Specification | Status | Implementation owners |
|---|---|---|---|
| 0001 | [D4C — ONE Toast-published current Menu, historical identity and optional recipe costs](0001-d4c-toast-menu-authority-and-owner-review.md) | **In Review:** current published menu from Toast only; **NO connected-café local Add Item or Owner review** (#6727941284); old test/manual rows remain storage-only for D3 safety; historical evidence-first Option B with unresolved-case C fallback approved, not implemented | POS0e (shared current reader) → POS0d (menu/catalog) → POS0f (migrated DB, one Supervisor and screen proof); exclusive code paths still require approval |
| 0002 | [POS-confirmed experiments **and independent 7-day published-price observations**](0002-pos-change-verified-experiment-activation.md) | **In Review:** plan activates ONLY after source-confirmed Toast target; owner-approved ~2-hour/next-morning reminders (max two per café-local day); N×24h experiment and final-close extension; **independent unrequested verified Toast price change automatically starts one Supervisor notice, seven daily observational reports and final analysis without an experiment** (#6728419191). Actual source/time/COGS, owner delivery, state representation and tests remain unimplemented | Existing Supervisor/Operating Board/commitments + POS0e shared reader → POS0d source/menu change signal → POS0f registered one-Supervisor/Menu/DB proof; exclusive implementation scope requires separate approval |

Draft PRs: [#398](https://github.com/killbill2792/aicafe/pull/398) (source/architecture) and [#400](https://github.com/killbill2792/aicafe/pull/400) (developer enforcement). Do not treat branch-local paths as merged into main.
