# Toast read-only café pilot — safe connection and activation sequence

PR stack: #57→#58→#59→#60→#61→#62→#63→#64→#65→#66 (draft; none auto-merged).

## Owner inputs (keep minimum)
1. Confirm Toast Standard API / RMS Essentials+ and the location's Manage Integrations 8.4 permission. Obtain **read-only API client ID and secret**, authorized restaurant GUIDs, and the official Toast reporting closeout for a historic business date.
2. Enter the credentials ONLY into AI CAFE's protected Toast owner setup form. Never send them by chat, email, Slack, or screenshots. No QuickBooks or inventory access is required.
3. Test the selected restaurant scopes. Any missing scopes or location verification block the pilot. Test staged menu catalog, employee roster and one fully closed historical business date only after explicit approval.

## Webhook setup
1. Operator configures \`TOAST_PUBLIC_WEBHOOK_ORIGIN\` as the exact trusted HTTPS app origin. It must not be derived from inbound request Host.
2. Owner chooses **Prepare webhook URL**. App creates a disabled subscription UUID with NO signing secret; this is not an active Toast subscription.
3. Owner enters that URL in Toast Web -> Integrations -> Toast API access -> Manage credentials -> Manage webhooks, category Orders, selects authorized credentials and contact email. Do NOT activate delivery yet.
4. Toast displays a unique signing secret; owner enters it only into the protected AI CAFE form and chooses **Store secret securely**. Server encrypts it and returns only a success indicator, never secret material.
5. Subscription remains \`enabled=false\`. An explicitly approved operator checks exact signature algorithm, retry/ACK latency, body/format, location mapping and replay against authorized Toast fixtures; THEN separately authorizes database \`enabled\` and global \`TOAST_WEBHOOKS_ENABLED\`. Neither switch is enabled by these PRs.
6. Revocation disables a subscription and clears the stored secret, preserving queued historical events for audit.

## Configurable automatic sync
- Owner can configure each verified restaurant's Orders, Attendance, Scheduled shifts, Catalog and Roster frequency (15–1440 minutes). Preference exists in DB but **does not schedule any execution** until operator sets \`TOAST_POLLING_ENABLED=true\`, \`TOAST_DISPATCH_ENABLED=true\`, \`TOAST_JOB_SECRET\`, and supplies a separately approved external scheduler for \`POST /api/pos/toast/jobs/dispatch\`.
- The scheduler must POST Bearer secret server-to-server over HTTPS, no customer data in payload, at an operator-approved cadence. Each call claims ONE due business/location/capability via \`FOR UPDATE SKIP LOCKED\`, verifies tenant mappings, then calls existing bounded Toast worker; completion/failure uses a nonce-fenced lease. **No existing \`vercel.json\` cron is modified.**
- Existing Order event worker requires \`TOAST_JOBS_ENABLED=true\`; no automatic financial promotion.
- Owner status GET reports capability success/failure, retry/rate limits, backfill needs and correction review counts. Do not treat silence or a zero-modification scan as verified zero sales.

## Hard financial and operational boundaries
- Automatic canonical sales promotion stays OFF. An independently obtained authorized Toast full-business-day report, refund/void payment business-date review, CSV overlap review and immutable baseline are prerequisites. Any stale provider corrections remain review-required; existing calculations and rollups unchanged.
- Toast roster and catalog remain separate. The owner explicitly links Toast identities to existing employees/menu items/modifiers. No names/prices/recipes/ingredient costs are overwritten; price changes have immutable observed version records.
- Imported paid timecards require valid owner mapping, actual clock-out and verified positive hourly wage, no overlapping manual/CSV/scheduled records, opt-in \`TOAST_LABOR_CANONICAL_ENABLED=true\` and explicit owner confirmation. Missing wages are never assumed to be zero; later provider edits are review-only. Scheduled shifts are not paid timecards.
- Supervisor sales guard excludes Toast-origin canonical business dates from confirmed trend numbers during authorized pilot until source coverage is separately verified. Other Square and CSV logic is untouched. Full report semantics require live Toast fixtures and an independently reviewed closeout; don't claim production readiness from local tests.

## Migration and test order
- Stage disposable Supabase with existing migrations 01–56, then apply additive migrations 57,58,59 in numerical order. Run \`scripts/toast-db-integration.sql\` transaction/rollback tests, \`npm run test\`, \`npx tsc --noEmit\`, \`npm run build\`, full and Toast-specific lint; do not hide baseline unrelated lint failures.
- Do NOT run production migrations, enable flags, merge any draft PR, publish webhook subscription or attach customer credentials without owner authorization. Never use production tokens in GitHub Actions.


## Final source-specific financial guard
The reporting helper intersects dates returned by \`toast_unverified_sales_dates\` with real canonical \`orders.pos_order_id LIKE 'toast:%'\` for the same RLS-authorized business and dates. This intentionally distinguishes *Toast evidence that may contaminate an aggregate rollup* from standalone staging, late payment GUID review or a pilot-only day. A standalone Square/CSV day stays visible even when Toast has an unrelated pilot record on that date. A mixed-source **daily aggregate** containing an unverified canonical Toast contribution must be withheld in Supervisor historical trend because the existing aggregate cannot separate provider cents or ingredient/staff allocations without a new financial formula. Independently verified Square/CSV order rows remain preserved in storage and other provider-specific reports, but the *mixed daily aggregate* is not misrepresented as verified. The UI receives a low-coverage/stale reason. Do not auto-promote or fabricate verified-zero days. A truncated/failed source check fails closed. Owner authorization and tenant RLS remain enforced.

Toast payment-date scanning currently records provider identifier evidence only, not verified refund amounts, settlement totals or full-day closeout coverage; these require authorized real Toast samples and independent source reports. \`TOAST_PILOT_IMPORT_ENABLED\`, \`TOAST_CANONICAL_PROMOTION_ENABLED\` and all other activation flags remain unset/false.
