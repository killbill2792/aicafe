# AI CAFE — verified integration checkpoint (November 14, 2026 UTC)

**Authority:** [AGENTS.md](AGENTS.md), [binding rules](docs/rules/) and the signed task/approval ledger. This is a **single-coordinator progress-only change**, not a replacement queue, authorization, deployment, provider credential or real-café acceptance. The [archived historical progress](docs/history/progress-snapshot-2026-11-05.md) remains unchanged.

**Status distinction:** `merged` = code present on `main`; focused `integrated_proven` = actual cross-feature tests/owner journey executed on identical combined source; `released_proven` requires independently verified live model, deployment and authorized real effects. Green fixture CI is not live release evidence.

## Now (five priorities)

1. **Four-task on-main integration:** Gmail Task 11 #472, file/photo → stock Task 12 #473, inventory/recipe Task 14A #471, and staff planning Task 13A original #474 **restored on main by [repair #480](https://github.com/killbill2792/aicafe/pull/480)**. Merge SHA `ccb7af008b44797f3965fa0a8b68622add2ceb42`; merged tree `54ce6d4e1fb1f74bd233c7e1eea52cb4178f5bea` **identical** to tested head `9d93b43d1b90efbf6d588060062477c5423602c0`.
2. **Keep signed task status truthful:** [proposed queue JSON](docs/plans/universal-supervisor-queue.json) still lists 11/12/13a/14a/17a as proposed. It is not the signed private CAS ledger. The authorized coordination workflow must reconcile signed entries; do **not** manually forge state/approval signatures based on this report.
3. **Release gates held:** real `gpt-6-luna` receipt holdout (50 originals/30 conversations), provider-backed Gmail connection/send, real photo-to-stock-screen receipt, cross-session worker/routines and café-specific labor/source parity have **not** been executed here. No authorized Vercel production deployment was verified.
4. **Next owner-approved implementation:** Task 13b–13d staff publication/response; Task 14b–14e supplier/receiving/invoice flows; Task 15 proactive operation. Do not infer they are delivered from 13A/14A.
5. **One-screen and parity:** Task 16 one-screen interactions and Task 17b–17e real operator/restart/trusted pilot and independently measured Grok/Muse comparison remain **unproven**. Retain POS0e/POS0f lineage and Task17A CI enforcement.

## Verified integration and exact evidence

| Task | On-main merge | Executed combined-tree evidence | Limit |
| --- | --- | --- | --- |
| **11 Gmail** | [#472](https://github.com/killbill2792/aicafe/pull/472) `230255b5` | OAuth/provider/tool regressions passed in [#480 CI](https://github.com/killbill2792/aicafe/actions/runs/43572274901) | Live provider delivery not proved |
| **12 File/photo/stock effects** | [#473](https://github.com/killbill2792/aicafe/pull/473) `52215bb6` | Purchase intent, duplicate/tenant effect-gateway DB and registered tools passed | Paid Luna photo→stock screen not proved |
| **13A Staff planning** | Original [#474](https://github.com/killbill2792/aicafe/pull/474) was merged only into a feature branch; [#480](https://github.com/killbill2792/aicafe/pull/480) fixed main, `ccb7af00` | 22 reviewed files, 32/32 recorded staffing scenarios, two-café RLS/Staff browser/screenshot checks passed | Real model staffing and external messaging not proved |
| **14A Inventory evidence** | [#471](https://github.com/killbill2792/aicafe/pull/471) `2787bc5a` | Inventory/recipe/variance unit and **20 DB assertions** passed | Live café source/stock parity not proved |
| **17A CI enforcement** | [#479](https://github.com/killbill2792/aicafe/pull/479) `cd9ba756` | Required owner-domain gate produced verified exact-head receipt | `provider_model_proof:false` |

**Full current-code integration:** [PR #480 exact-head CI #43572274901](https://github.com/killbill2792/aicafe/actions/runs/43572274901) **13/13 required jobs green**: repo guards, TypeScript/lint, production build, 3 Vitest shards, Promptfoo, evaluator integrity, **39 selected owner-domain tests**, **72/72 migrated DB cases**, 1/1 authenticated Staff browser scenario. Separate [Staff screenshots #43572274899](https://github.com/killbill2792/aicafe/actions/runs/43572274899) passed. [Final Codex #6874051498](https://github.com/killbill2792/aicafe/pull/480#issuecomment-6874051498) clean. The merged main source tree is **byte-identical to that test candidate**. This is substantial nonproduction integration evidence but **not a multi-domain real-model one-screen or production release pass**.

## Next

- Coordinator: reconcile private signed ledger using actual merged SHAs and CI, without manual edits to the proposed DAG.
- Owner-approved trusted test environment: run independently reviewed original receipt/Luna and Gmail test-account flows, verify persisted effects, Staff/Menu/Home parity, worker restart and recovery. Only then consider `released_proven`.
- Continue Tasks 13b–17e per actual signed dependency, not stale checkboxes. Avoid Vercel previews and unsanctioned production writes.

## Done (recent verified main merges; code only)

- [x] #480 Task 13A actual-main repair — `ccb7af008b44797f3965fa0a8b68622add2ceb42`.
- [x] #473 Task 12 — `52215bb6140aa87de0b54161a7c9c76037a808ae`.
- [x] #471 Task 14A — `2787bc5a01136abc3adb5862c26464d93bac174e`.
- [x] #472 Task 11 — `230255b5727bddfb1d84d02094b2d2e7dd7e1654`.
- [x] #479 Task 17A CI — `cd9ba756ae3f2d53a673faf3cf050f3761e55df0`.
- [x] #478 live acceptance *runner* — `fd404dcf401049eb59406f211b4404df040cb8c6` (paid run still unproven).
- [x] #476 evaluator integrity — `2b1dc1bd1d1e4758d80812efe3667fe9a1912985`.
- [x] #443 effect gateway — `362284686e70d325750332e1f14f5abe16596c5a`.
- [x] #442 rolling memory — `94126941ae7d4461544feaf4560ba81f65c338c6`.
- [x] #437 routines — `0ed09261b878f75b46843c415a84ee634aa0361c`.

These are **code merges**, not claims of deployed release proof. Prior history remains accessible via Git and the archive.
