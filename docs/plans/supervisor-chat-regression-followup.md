# Urgent Supervisor chat regressions after #541 — scope for owner approval

Status: read-only production diagnosis and source audit, implementation scope pending exact owner approval. Base main 7fdcaafa977504db999f976c139be7a6374d1802. No production changes, paid model calls, migrations, deployment or scope expansion.

## Confirmed owner-visible defects and expected outcome

- A simple sales + peak-hours question failed. Production turn telemetry confirms 60,003 ms, timeout, six model calls, seven tool calls, four distinct tool names including event lookup, no answer sentences, then agent_turn_failed. Separate Supabase/PostgREST logs establish real statement and connection-pool timeouts in the same incident window; active ai_query_view calls observed up to 57s. This is not proof that a particular SQL statement caused the owner turn. Do not blindly raise turn budgets, increase pool capacity, kill sessions, disable crons, or claim a missing migration.
- ChatStart renders the events card even when collapsed; SupervisorChatComposer pins it and a multi-line sales/attention overview above the active scroll. The conversation should occupy the screen; use one compact overview affordance and reveal the existing events and numbers only on explicit expansion in active chat. Keep all business features, freshness/partial labels and event calendar; no second reader or dashboard. Mobile initial screen and active chat should have one natural conversation scroll and keyboard-safe composer.
- SupervisorChatComposer renders the entire saved Work status list in every transcript despite the existing Work drawer. Replace automatic full cards with a compact, accessible affordance to the same original saved Work; keep approval/reply/failure access, persistent IDs, exact navigation, and verified receipt distinction. Hide technical receipts behind details where appropriate, never hide required decisions or uncertain effects.
- ChatJobProgress renders every retained progress step as a line, and composer can show a second status. Show one short truthful live status, deduplicate repeats, keep detailed activity only on explicit request if needed. No fabricated completed steps, no duplicate screen-reader announcements; preserve genuine pending, error, cancellation, stop live view and resumed work semantics. Clear stale status after a reply.
- Closing an event chip sets eventContext to null but a subsequent thread/message refresh reconstructs it from the title. Store explicit dismissal in the existing client thread selection state, distinguish dismissed vs uninitialized, preserve through refresh/poll/send/retry/back-to-thread as appropriate (session-local, no new database). Re-arm only when the owner explicitly selects an event; preserve actual event IDs for deliberate event questions and exact idempotent retry payload. Do not inject event context into a general sales question after dismissal; no keyword/intent router, no rewriting historical messages.

## Proposed exact UI implementation scope

- components/home/SupervisorChatComposer.tsx
- components/home/ChatStart.tsx
- components/home/ChatJobProgress.tsx
- components/home/chatExperience.ts
- components/home/chatExperience.test.ts
- components/home/eventDayThread.ts
- components/home/eventDayThread.test.ts
- tests/e2e/owner-journeys.spec.mjs
- messages/en.json only if a new English accessibility label is necessary

Reuse existing Work drawer and current components; no backend/persistence change in UI patch. Scope includes updating affected old UI navigation expectations without deleting or weakening source, work, error, security, or isolation assertions. Add specific regression assertions to existing cases; keep inherited titles/gates.

## Urgent answer reliability investigation (separate exact repair scope after diagnosis)

Follow the existing endpoint app/api/ai/threads/[threadId]/agent/route.ts -> lib/ai/conversations/agentRunner.server.ts -> lib/ai/agent/loop.server.ts -> canonical registered today/sales/peak-hours readers; inspect existing query_data RPC, actual ai_query_view, active shared current reader, #539 changes, cron concurrency and DB telemetry. Active customer-aware functions are present, so do not assume missing migration. Assess source-bound query plans, range and work expansion, connection occupancy, duplicate read selection, retry/poll behavior, reserve for a final grounded useful partial answer, and persistence. Separate UI context-reinjection from backend timeout. No hardcoded intent router, no second reader, no unverified monetary numbers, no relaxation of approval or tenant boundaries. Propose exact backend paths and any migration separately before writing. No production SQL write or configuration change under this diagnosis.

## Required verification

Authenticated seeded local browser: mobile 320/390/430, tablet 768, desktop 1440, light/dark, keyboard/focus. Ordinary chat with many saved work items and events: opening conversation is chat-first; overview expansion and event access remain available; Work remains accessible by exact saved identity, no transcript card wall; one status even with alternating duplicate tool labels; existing answer clears progress. Dismiss event chip while thread reload, work polling, reconnect and send occur; no automatic restore and no event prefix in new ordinary question; explicit event selection restores exact context; retry reuses original payload, no duplicate send or effect. Preserve approval and uncertainty, files, history, screen reader semantics and original event date/identity.

Ordinary tests: current-head lint/type/build/Vitest, required E2 and DB/security gates, no reported pass before real execution. Backend regression needs correct bounded sales and peak hours, source/as-of and independently checked POS facts, not just HTTP 200; no-provider failure injection plus separately authorized affected Luna case in the existing shared Task17 campaign. Compare query and response latency before/after on representative disposable data. Do not initiate paid tests. Maintain all CI/Codex/release gates. Coordinate #533 overall, #534 persistence/recovery, #535 browser UX; realign them after any verified hotfix merge, no duplicate changes.
