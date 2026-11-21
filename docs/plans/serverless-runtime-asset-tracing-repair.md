# Serverless runtime assets — incident repair and prevention

## Owner authorization and boundaries (2026-11-21)

Owner explicitly approved (this task's chat) an isolated serverless packaging fix **plus** long-term build-verification tests for omitted runtime assets, and an audit for similarly missed packaging risks. This is **not** approval to disable the SQL safety admission, change the one Supervisor loop, add a scheduler, touch schema/RLS, call paid Luna, run production effects or enable Vercel previews. Preserve all merged U0–U5 / PR542 UI, and do not edit `PROGRESS.md`.

## Observed incident / reproducible failure (not inference)

- Current `main` at investigation start: `fc06fd8cc39a7eebcff440589d212622447f071d`, squash merge of UI PR542. Vercel production deployment `dpl_2xmTYLTHZMZKCDSxFYzqnWZ7ZRib` for the same SHA reported READY.
- Real *new-deployment* function logs at 2026-11-21 21:19–21:23 UTC repeatedly show `ENOENT /var/task/node_modules/@supabase/pg-parser/wasm/17/pg-parser.wasm`, an unhandled WASM initialization error, on `/api/cron/whatsapp-supervisor` and `/api/cron/toast-sync`; logs also mention `/api/cron/refresh-derived`. Earlier deployments failed identically. Do not count three stderr messages from a request as three separate business effects.
- `lib/ai/agent/tools/u3SqlAdmission.ts` imports `PgParser` and initializes `new PgParser({version:17})`; version `@supabase/pg-parser@0.1.7` uses an external Postgres 17 WASM binary. The existing `next.config.ts` has no `outputFileTracingIncludes`.
- The baseline CI production build is `npm run build -- --webpack`; the Git-linked Vercel deployment built Next.js 16.3.6 with **Turbopack**. Passing the former cannot attest Turbopack's deployed trace/asset.
- **Separate possible fault:** `/api/cron/refresh-derived` has also timed out at 300 s. Its cause is not demonstrated to be the WASM omission; record independently and route to U1/Task17C if still present. Do not alter background behavior or cron timeouts in this PR.

### Architecture/source and data map
- Runtime input: developer-authored `SELECT` research SQL, admitted by the **existing** parser then source/tenant guards, never SQL read directly from this PR.
- Physical dependency: `node_modules/@supabase/pg-parser/wasm/17/pg-parser.wasm`, loaded during serverless SQL-admission initialization.
- Deployment artifact: Next.js `.nft.json` route traces and the files assembled into each hosted Node function by the existing Vercel Git integration.
- No new DB record/key, no modified source field, business data, model selection, cache, notification, worker or executable effect. Root cause hypothesis is missing asset in deployment packaging; production `ENOENT` is proved, exact trace omission must be independently checked.

## Approved implementation scope (exact paths)

1. `next.config.ts` — narrow supported Next.js `outputFileTracingIncludes` for the existing PG17 WASM file on Node server routes which may load the Supervisor SQL admission; maintain all current server-action options. Do **not** add a custom copy step to production or a duplicate parser.
2. `scripts/acceptance/serverless-assets.mjs` and `scripts/acceptance/serverless-assets.test.mjs` — fail-closed tests of *real* Next.js `.nft.json` route traces and required asset file presence; cover missing trace, missing file, invalid/empty trace, only-one-route-present, explicit asset omission, and safe real trace. This is a package guard, not an artificial static config string assertion.
3. `.github/workflows/ai-cafe-pr-baseline.yml` — execute the test and guard on a real **Turbopack** production build in addition to existing Webpack CI; no Vercel preview or cost-bearing deploy. Do not mark a skipped/no-output guard successful.
4. This plan and the same PR body — maintain a self-contained incident analysis, exact scope, executed tests, current-head CI/Codex, comment dispositions and next-actions handoff. Do not edit any parallel feature branches or shared `PROGRESS.md`.
5. Only if same-family artifact audit actually finds another missing runtime asset with a reproducible, documented path, extend this *same* PR narrowly to the supported tracing include and its regression test. Unrelated runtime timeout, owner device, customer effects and actual Luna work remain assigned to Task17B/C/D/E, not silently declared fixed.

### Why this is the minimum viable repair
Next.js and Vercel explicitly support `outputFileTracingIncludes` for assets dynamically loaded from `node_modules` and otherwise omitted by file tracing. The authoritative paths are the real package files, and their traces must be checked, not merely the existence of a setting. Never bypass `admitU3Sql`, return unverified successful results, or turn off failing cron jobs to hide errors.

## Completion checklist — check a box ONLY with exact executed proof

### Investigation / source
- [x] Confirm same error on **new** production deployment with exact path and request/route.
- [x] Verify parser dependency, version, initialization and pre-fix Next config.
- [x] Identify non-equivalent Webpack CI vs production Turbopack build.
- [ ] Audit app runtime dynamic/non-JS assets and recent Vercel missing-file logs; account for every reproducible *same-class* risk without broad redesign.
- [ ] Produce pre-fix red test against actual trace (or controlled fixture simulating omission), not only a hypothetical assertion.

### Implementation / verification
- [ ] Trace includes PG17 WASM for every applicable serverless route (cron and Supervisor API); preserve all source admission checks.
- [ ] Guard refuses missing runtime artifact, omitted file in trace, missing route trace, corrupt trace, and missing output directory.
- [ ] Tests demonstrate original failure goes red, intended trace goes green, and existing U3 `SELECT` admission / injection / foreign-scope negative assertions still pass.
- [ ] CI runs **both** existing Webpack and production-matching Turbopack builds; new guard checks real generated route traces. No skip/allow-failure or reduction of existing jobs.
- [ ] Exact-head all mandated CI: lint/types, all Vitest shards, production build, DB, authenticated owner browser, repo guard, integrity and Events (as applicable).
- [ ] Audit no modified schema, RLS, model provider, salaries, imports, source readers, effects, schedules, crew UI or PR542 chat paths.
- [ ] Resolve every Codex inline finding, re-run CI after changed code, and obtain final-head clean review only when CI is fully green.
- [ ] Revalidate latest `main`, active PR overlaps and code ownership; document merge/readiness decision. Do not force-push or overwrite other workers.

### Hosted operational proof (a separate gate — never claim from green CI)
- [ ] If separately authorized to merge into Git-linked production, confirm exact deployment SHA/READY **and** that its emitted function contains the binary (not just main build).
- [ ] Verify production serverless initialization for affected cron and SQL-admission paths no longer emits `pg-parser.wasm` ENOENT, using safe authorized observational checks; do not send manual effectful cron invocations without separate permission.
- [ ] Confirm successful read-only/negative admission behavior and no incorrect success/duplicate work after routine cron; record remaining 300 s timeout independently.
- [ ] Hand Task17B/C/D/E outstanding genuine model/source/worker/owner-device/release scenarios without marking them PASS. Production `released_proven` stays NOT_PROVEN until those owners provide evidence.

## Handoff instructions for any successor agent

1. Read **latest** `AGENTS.md`, `PROGRESS.md`, `docs/rules/workflow-and-review.md`, `docs/rules/tests.md`, and local `aicafe-pr-lifecycle`, `aicafe-proof-gate`, `systematic-debugging` skills. Do not trust this plan over current code or GitHub run state.
2. Read THIS PR's whole body, comments and review threads; compare exact head/base and changed paths to the approved list. Do not reopen PR542 or take Task17B/C/D/Staff PR550 files.
3. Inspect Vercel logs for deployment `dpl_2xmTYLTHZMZKCDSxFYzqnWZ7ZRib` *without invoking a live cron*, and inspect the final `.nft.json` paths from the actual CI build. Keep red trace/asset evidence and failure cases.
4. After each push, monitor exact-head GitHub Actions through terminal results; fix only real failures. Publish an explicit `aicafe-workflow-handoff` comment with run ID/head/next step if session must end.
5. Only request Codex after latest-head full CI is green. Because Git-linked `main` deploys to production and existing cron routes are already active, treat release/merge as a **separate operational safety decision**, not implied by authorizing this PR's code. Never claim actual hosted improvement before an authorized merged deployment is verified.

### Evidence links
- Merged UI PR: https://github.com/killbill2792/aicafe/pull/542
- Affected Vercel production deployment: https://vercel.com/stylits-projects/cafe-profit/2xmTYLTHZMZKCDSxFYzqnWZ7ZRib
- Accepted previous UI CI: https://github.com/killbill2792/aicafe/actions/runs/44948019601
- Next.js supported tracing: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Vercel runtime file bundling: https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions
