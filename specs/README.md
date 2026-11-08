# Architecture specifications

Specs are reviewable documentation, not implementation authorization. Status must move through Draft → In Review → Accepted → Implemented; owner approval is required before code, migration, queue activation or merge.

| Number | Specification | Status | Implementation owners |
|---|---|---|---|
| 0001 | [D4C — Toast-first menu authority, owner review, and historical variant safety](0001-d4c-toast-menu-authority-and-owner-review.md) | **In Review:** owner-approved behavior consolidated; remaining decisions in §8 | POS0d (menu/catalog), POS0f (integration proof); exact UI/shared file owner TBD |
| 0002 | [POS-confirmed experiments — plans are not operating changes](0002-pos-change-verified-experiment-activation.md) | **In Review:** owner-approved Toast source-confirmation **and +2-hour/next-morning, max-two-per-café-day reminder cadence (decision CLOSED 2026-11-08)**; partial-day counting, schema/owner and executable proof pending | Existing Supervisor experiment workflow + POS0d published-price evidence; exclusive code ownership TBD |

Draft PRs: [#398](https://github.com/killbill2792/aicafe/pull/398) (source/architecture) and [#400](https://github.com/killbill2792/aicafe/pull/400) (developer enforcement). Do not treat branch-local paths as merged into main.
