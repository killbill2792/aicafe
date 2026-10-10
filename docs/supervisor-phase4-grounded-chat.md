# Phase 4 — verified Supervisor text chat

Phase 4 makes the Phase 1 Ask anything control a **real, persisted read-only conversation** using the Phase 3 thread/message API and Phase 2 `BusinessScopedCafeTools`. It is an intentionally **finite deterministic intent router**, not a general-purpose natural-language model or an independently acting team of chatbots.

## Supported verified flows

1. "How are we doing today?", "What was our profit this month?", "What about this week?" (last seven calendar days), similar EN/ES/AR phrasing: exact net sales, total costs and owner profit **from the existing `getProfitability` tool** for the supported calendar period; requests for yesterday, previous month/week or future dates explicitly fail closed; if sales coverage, product costs, processing fees or bills are missing, explain insufficient evidence, never guess a number. Estimated payroll, bills or fees are clearly marked.
2. "What needs my attention?", "Any staff issues?": **read-only persisted Team inbox** (owner-needed, handled, watching, or Olivia-specific outstanding tasks). Zero open Olivia tasks is not a certification of staff coverage; no task status is changed.
3. "Should I change prices?": list at most three canonical pricing-engine **review recommendations** with current cost/benchmark source, label estimates, and say explicitly that no prices are applied. No market/elasticity claims are inferred.
4. "What about bills/rent?": only calendar-prorated recurring bills from the pure running-costs engine, **not** all operational costs.
5. Unsupported questions: explicit safe message listing supported topics; no model guesses or fabricated replies.

Every output is a validated `GroundedSupervisorReply` with `verified | estimated | insufficient_evidence` status and structured blocks. Monetary blocks have safe integer cents, an **exactly matching** evidence reference and a real period. Stale/missing sources cannot produce verified facts. No AI provider is called by this release.

## Identity, storage and security

- Existing Phase 3 owner/café RLS thread and message tables are reused. No new migration or change to financial tables.
- The existing authenticated POST validates same-origin, JSON, locale, owner text and a client idempotency key; server chooses the café, owner and tools.
- The server first persists the owner-authored message, then checks whether an audited Supervisor reply already exists; if so, returns it. Otherwise the deterministic router executes **only** scoped allow-listed read tools.
- A server-only privileged writer stores structured blocks **only after validation** (no metric without exact evidence, no metrics with insufficient evidence). It links immutable provenance to the original owner message. The reply's stable UUID makes concurrent retries idempotent.
- There is no client-exposed Supervisor-write route, arbitrary tool executor, direct SQL interface, POS write, price approval, task reconciliation, or worker message mutation. Existing financial screens and AI Team workflow remain intact.
- All responses are private/no-store and sensitive user prompts are not logged.

## Activation (deliberately default off)

1. Confirm the **existing Phase 3 SQL migration 33** (`20261010000033_ai_conversations.sql`) was applied safely and reconciled with Supabase migration history. **Do not run an unreconciled `supabase db push`.**
2. Verify authenticated owner, manager and other-owner RLS behavior in staging. Confirm `SUPABASE_SERVICE_ROLE_KEY` remains **server-only** (never NEXT_PUBLIC).
3. In the staging deployment, set `SUPERVISOR_CHAT_ENABLED=true`, redeploy, and test in EN/ES/AR.
4. Owner sees real transcript, recent conversations, new conversation, suggestion shortcuts and composer; microphone and attachment buttons remain disabled. The app stays in its safe Phase 1 disabled mode if the flag is absent, Supabase is unconfigured or no authenticated user is present.
5. Verify fixture or staging café scenarios: full data, partial data, estimated fees, missing recipes, missing task reader, pricing review, unknown prompt, back/forward history and retry after network interruption.
6. Only after these checks enable the flag on production and redeploy. Do not confuse **Vercel build success** with evidence that production Supabase migration history has been reconciled.

## Deliberately deferred

This phase is not unrestricted "ask anything". Natural-language intent beyond the enumerated commands, multi-step planning, verified third-party research, voice transcription, attachments, owner-editable rules, staff messaging, WhatsApp and approved business writes require later phases. The safe fallback tells owners what is supported instead of inventing unsupported answers.

No new npm dependencies, Supabase schema, POS mutations, money math or task lifecycle changes were introduced.

## CI/deployment status for this implementation
GitHub Actions passed TypeScript, changed-file ESLint, 501 Vitest tests and the production build. Vercel's preview status on this PR is a **build-rate limit**, not a code compilation error. Retry Vercel preview after the rate limit clears and perform a logged-in staging walkthrough before turning on the feature flag in production.
