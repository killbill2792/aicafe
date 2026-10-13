# AI CAFE — First authorized Toast real-API smoke test (read-only, repeatable)

**Status:** Operator checklist only. This PR does not connect a restaurant, enable a flag, publish a webhook, schedule a job, migrate a production database, or promote financial data. Preserve existing Square, CSV, Supervisor UI/AI Team and every financial formula.

## 0. Preconditions / approval gate
- [ ] Owner explicitly authorizes ONE restaurant/location, read-only scope and limited test dates. Operator records authorization and expiry in a private approved system (no credential values in issue/PR/chat).
- [ ] Confirm actual Toast account entitlement/API access; get the correct official API host, **restaurant GUID**, API client ID + client secret and permitted read scopes from the owner's Toast integrations administration. Don't ask for a Toast login/password.
- [ ] Confirm AI CAFE business/location mapping matches this exact restaurant GUID, not a similar brand or franchise location; prohibit demo tenant and cross-café data.
- [ ] Use isolated **staging** with completed additive migrations 40–59 and synthetic verification beforehand. DO NOT apply a database migration or enable flags in production, and do not use production API secrets in GitHub CI.
- [ ] Arrange a trusted independent Toast closeout/export for one ordinary closed business date and one date with a real refund/void, under owner approval. If provided only a daily screen total rather than transaction-grade detail, mark verification incomplete.
- [ ] Assign an operator and rollback owner; agree on date/time/timezone, comparison tolerance (document explicit rounding policy, do not invent), request limits, incident/stop threshold and credential expiration. Keep audit references sanitized.
- [ ] Before **any** staging feature flag is enabled, obtain separate operator/owner change approval. This PR changes none. Production flags remain false/unset throughout.

## 1. Secret handling and least privilege
- [ ] Only enter credential material through the authenticated owner-only secure Toast setup form over HTTPS; ensure token encryption key is configured privately in approved runtime. Never paste secrets into repository, terminal history, log, PR, chat, CI env dump, screenshot or an email.
- [ ] Verify server never returns the client secret, bearer token, webhook signing secret or encrypted-at-rest values. Browser-visible status is redacted. Check logs/errors/telemetry for accidental sensitive identifiers.
- [ ] Ensure session authorization and membership are owner-scoped and a different authenticated member/business gets 403. Confirm mock/demo businesses are rejected.
- [ ] Read-only authorization: do not send write/change requests to Toast. The local staging RPCs may persist *read-only observations*; this is not financial promotion or writes to Toast.

## 2. Minimal connection tests (staging only after approval)
- [ ] With all flags initially disabled, confirm setup and pilot POSTs return disabled (503), scheduler dispatcher returns disabled, webhook subscription is inactive, and no canonical paid shift/sale/menu/recipe is written.
- [ ] Separately approve **staging-only setup access** if necessary, configure ONE authorized GUID/client in owner UI, then invoke the existing owner "Test connection" flow; check authorization to restaurant details, menu metadata, orders, employees, time entries and scheduled shifts.
- [ ] Confirm the exact response restaurant GUID equals the configured restaurant; reject wrong-restaurant payloads rather than accepting a valid token from another location.
- [ ] Distinguish missing permissions (403/Toast scope denial) from bad credentials (401), rate limit (429), timeout, service outage (5xx), unexpected JSON and partial response. On failure do not claim verified connection or truncate historical state.
- [ ] Confirm token retrieval/refresh under safe authorized credentials, and that rotation/revocation invalidates verified status without orphaning prior auditable Toast event records.

## 3. Sales and historical reconciliation — *no promotion*
- [ ] Fetch a closed *nonzero* date, and stage normalized orders only. Compare independent Toast closeout detail vs order-level gross, discounts, tax, tips, refunds, net sales, processing fees (where the authorized API actually provides them), orders, voids and payment settlements. Every mismatch is **review required**, never an auto-adjustment.
- [ ] Exercise 50, 100 and 250 modified-order pages; confirm no duplicate staging, all pages fetched, a failed page is resumable, lease nonces are fenced and poll cursor advances only after a complete bounded window. Replay same completed order with newer modified timestamp; no false correction.
- [ ] Verify "checks: []", open/unpaid/partial/refunded/voided/deleted/reopened and malformed orders do not create silent confirmed revenue. Test out-of-order older provider versions: newer staged facts win.
- [ ] Stage a historical day with a refund or void and check the **actual payment business date** (including a refund on a later date). A payment GUID scan is a review signal; it is **not proof of refund dollars, net settlement, or complete payment coverage**.
- [ ] Fetch a closed date believed to have **zero** sales. Confirm independently complete closeout evidence and coverage before marking it as a verified $0 day. Empty modified-order polling alone MUST remain unknown.
- [ ] Include an existing CSV/Square day and test repeat import overlap/canonical order IDs to prevent double counting; a Toast pilot-only day must NOT hide independently verified Square/CSV sales. Where mixed-source aggregate cents cannot be separated, flag that aggregate as unverified rather than modifying calculations.
- [ ] For >30-day gaps test durable recovery window progression and missing-history review. Never assume the API can supply a period outside its supported retention.
- [ ] Verify post-promotion provider corrections *in synthetic/staging fixtures only* mark "needs review" while preserving historical canonical amounts; don't promote real café data in this pilot.
- [ ] Record redacted reconciliation results by restaurant/date/source and independent report ID; never record raw API credentials, customer PII or full transaction payload in PRs.

## 4. Staff, attendance, and menu — staging / explicit matching
- [ ] Read Toast employee roster and actual labor entries. Compare employee GUID, start/end, unpaid breaks, timezone/DST, wage state and deleted/edited punches. Scheduled shifts are **not actual attendance**.
- [ ] Exercise missing employee match, missing/unknown wage, positive verified hourly wage, open punch, owner-corrected punch, overlap with manual/CSV/scheduled record and repeated import. All unknown/overlap/owner-corrected cases should block or require review; never assume a $0 wage or overwrite past payroll.
- [ ] Read menu items, multiple sizes, modifier groups/options, price variations, variable/open-price cases, archived products. Preserve existing recipes, ingredient costs, quantities, owner pricing, and price history.
- [ ] Owner selects a canonical employee/item/modifier explicitly in review UI and sees a confirmation with both identities. An unselected/declined match must produce **no link**. Verify tenant isolation and conflict rejection.
- [ ] Leave automatic canonical attendance, revenue and recipe/menu updates **disabled**. An approved mapping is metadata only, not authorization to change payroll or finance.

## 5. Webhook and sync (provisioning ONLY)
- [ ] Configure a trusted fixed HTTPS origin in isolated staging; reject request-Host-derived URLs. Prepare subscription UUID, confirm disabled and no signing secret exposed. Do not register a production webhook or enable subscriptions during the initial read-only pilot.
- [ ] If specifically approved for a **separate controlled webhook replay test**, use safely captured *authorized* redacted fixtures, verify exact Toast signature algorithm, raw-body HMAC, timestamp/replay defenses, disabled receiver behavior, wrong secret, tampered body, duplicate event GUID, wrong restaurant and invalid JSON. Never log the secret or customer payload.
- [ ] Preferences for orders/attendance/schedules/roster/catalog remain inert absent separate scheduler + \`TOAST_DISPATCH_ENABLED\`, \`TOAST_POLLING_ENABLED\`, \`TOAST_JOB_SECRET\`. Do not touch \`vercel.json\`, Vercel cron, or production schedules.
- [ ] Verify retries and health status on 401, 403, 429 (respect Retry-After), 5xx/timeouts, 100-item boundaries, lease expiry, recovery failures, cancellation and reconnect. No premature success indicators.

## 6. Negative/security regression matrix
| Case | Required observable result |
| --- | --- |
| Unauthorized user, other café or demo | Forbidden/no data or no action |
| Invalid/wrong restaurant GUID | Rejected, previous verified mapping not silently reused |
| Expired/rotated client credentials | Reverification needed, no token exposure |
| Missing Toast entitlement/scope | Explicit limited/missing-permissions status |
| 429, 5xx, network timeout | Bounded retry/error status, safe durable cursor |
| Truncated/invalid payload or 0 checks | Incomplete/ambiguous, never confirmed zero or net sales |
| Missing independent closeout | Unverified sales; financial promotion blocked |
| Late refund/void/reopen/delete | Review-required, old canonical cents untouched |
| Replayed webhook/bad signature | Rejected/idempotent, no unauthorized write |
| Overlapping Square/CSV or staff records | No double count/overwrite |
| Unknown wage or variable menu price | Null/needs review; no zero wage or guessed cents |
| Owner declines mapping | No canonical link or recipe/employee mutation |
| Staging flag unset and dispatcher not configured | No automatic Toast jobs or promotion |

## 7. Stop conditions, clean-up and signoff
- [ ] STOP on wrong location, permission mismatch, credential exposure, financial discrepancy, source overlap, unknown refund-date/accounting, failed scope boundary or stale/order cursor anomalies. Mark affected day as needs review and disable staging test access.
- [ ] Revoke temporary testing credentials/webhook drafts as authorized; leave prod Toast flags **unset/false** and all automatic promotion, labor import, dispatcher and webhook jobs disabled.
- [ ] Independently reconcile at least one closed day and one corrected day, including refund settlement and a verified-zero-day proof, before requesting a future promotion approval. Record owner and operator signoffs and reporting provenance.
- [ ] Smoke-test outcome must distinguish **connection works**, **read-only staging works**, **financially reconciled**, and **safe to promote**. The first two do NOT imply the last two.
- [ ] Never mark production-ready, merge this PR or turn on production flags as a side effect of this checklist.

## Repo checks for consolidation PR
- [ ] \`npm run test\`, \`npx tsc --noEmit\`, \`npm run build\`.
- [ ] Isolated GitHub Action \`Toast disposable database integration\` must replay *all* migrations, through 59, and execute \`scripts/toast-db-integration.sql\` on local disposable Supabase with rollback.
- [ ] Confirm exactly one file for each Toast migration 40–59; main already had 40, 41 and 47. Do not reapply 40/41/47 or edit them.
- [ ] Inspect CI failure scopes: preexisting lint errors outside Toast do not justify broad refactors/suppression.
- [ ] Verify all Toast activation variables remain false/unset **in repository defaults**. Actual live environment settings are a separate operator audit and cannot be inferred from GitHub source.
