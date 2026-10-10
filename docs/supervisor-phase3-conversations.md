# Supervisor Phase 3 — private conversation persistence

This is the durable **conversation foundation**, not a functional generic chatbot.
It is intentionally separate from the already-merged Supervisor Home and Phase 2
`BusinessScopedCafeTools` read-only calculation/evidence boundary.

## Deployment order

1. Confirm which migrations are **actually applied** to the production Supabase database.
   Migration history is known to be unreconciled. Never run `supabase db push` blindly.
2. Review and apply `supabase/migrations/20261010000033_ai_conversations.sql`
   once, deliberately, through the production-approved migration process.
   It creates only `ai_threads` and `ai_messages`, related RLS/grants,
   and a narrow thread timestamp trigger. It does not alter financial tables.
3. Exercise owner/manager, different-owner same café, and cross-business RLS
   checks in an authenticated staging database before permitting live traffic.
4. Deploy the app code. If the schema is absent, new API routes return 503 and
   existing Home, money, pricing, Team, POS, and tasks remain unaffected.
5. Phase 4 may then add approved structured Supervisor responses and connect
   the current disabled Ask anything UI after end-to-end evidence tests.

## Security and data model

- `ai_threads` stores `business_id`, `owner_user_id`, a client-generated
  `client_request_id` for idempotency, an **optional** title (render localized
  fallback copy in the future UI), and created/updated timestamps.
- `ai_messages` stores a composite
  `(business_id, thread_id, owner_user_id)` FK to its parent thread,
  author identity, immutable role, text or structured content, grounding,
  and a client-generated message retry key.
- Both RLS policies verify the signed-in user owns the record **and** is
  currently an owner of that café. A manager cannot see owner conversations;
  another owner of the same café cannot see another owner's history.
- Authenticated inserts permit **only** owner-authored text. No authenticated
  client (including someone calling Supabase directly) can forge a Supervisor
  response or claim tool-derived evidence. There is no authenticated
  UPDATE/DELETE policy. Supervisor messages will require a separately approved
  server-side privileged writer, a verified grounding status and an audit trail.
- Cascading café/account deletion deletes associated conversation records.
- Client retries with the same request/message key return the original record;
  reusing a key with different content returns a conflict, not a silent edit.
- No prompts, attachments, tokens, staff data, or results are logged by these routes.
  Treat stored owner messages as sensitive private conversation content.

## API (not yet connected to Home)

Cookie-authenticated, same-origin owner-only operations; no demo fixture fallback
or client-selected business/user ID.

| Request | Purpose |
|---|---|
| `GET /api/ai/threads?offset=0` | Latest 20 of this owner's threads, with nextOffset |
| `POST /api/ai/threads` | Create thread from JSON `{ "requestId": "UUID", "title": "optional" }` |
| `GET /api/ai/threads/:threadId/messages?offset=0` | Latest 50 messages; nextOffset for older history |
| `POST /api/ai/threads/:threadId/messages` | Persist only `{ "clientMessageId": "UUID", "text": "..." }` |

POSTs require JSON and a matching Origin; 8KB request-body cap; strict
validation rejects unrecognized `role`, `businessId`, `ownerUserId`,
`grounding`, and `tool` fields. All responses use `private, no-store`.
A saved owner message explicitly returns `replyStatus: "not_enabled"`.
**No AI reply, employee message, POS write, price change or background job is
triggered.** The UI is still intentionally disabled.

The `assessGrounding()` contract provides future routing a fail-closed
`verified | estimated | insufficient_evidence` assessment with explicit
source references. It does not generate responses, choose intents, or
fabricate business numbers.

## Verification

Automated tests cover input schemas, owner identity isolation at the service
boundary, idempotent retries and conflicts, same-origin and size validation,
evidence gate behavior, and source-level migration invariants.
These are **not a substitute for live PostgreSQL RLS integration tests**.
Before enabling the composer or Supervisor writes, test with two real owner
identities, a manager identity, and two café memberships under Supabase RLS.

Do not implement conversation -> generic LLM -> answer. Phase 4 must resolve
intent -> scoped read-only tools -> evidence gate -> structured response, and
later approval gates for any business mutation.
