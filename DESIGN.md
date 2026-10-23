# Chat experience: fast, short, remembers, never stuck

## In plain words (read this first)

- **Shorter, clearer answers.** The assistant answers first in 2–3 sentences, then gives one next step. It says exactly what data is missing, and it replies in the language you wrote in. Tables and lists can still be long.
- **You see it working right away.** Within about a second the chat shows "Got it — working on it", followed by a line for each step (for example "Checked sales", "Checked menu prices").
- **Leaving the page doesn't lose the answer.** If you reload, close the tab or come back later, the work carries on. When you return, the progress and the finished answer appear on their own.
- **You can keep typing.** Send another message while it's working and it's added to the same answer when there's still time. Otherwise it's answered straight afterwards, so you never get "busy, try again".
- **It remembers your café, but only with your OK.** When you tell it something worth keeping ("we close at 3 on Sundays"), it shows a **Remember / Not now** card. Nothing is saved until you tap Remember. It holds at most 20 short facts.
- **It never fails silently.** If something goes wrong you get one plain line, such as "That took too long — please send it again." A job that stops responding is marked failed after 3 minutes, so it can't spin forever.
- **Off by default.** Three switches (`CHAT_STYLE_V2`, `CHAT_JOBS`, `CHAT_MEMORY`) turn each part on separately. With all three off, the app behaves exactly as it does today.
- **Cost.** Expect roughly +5–10% input tokens on a typical turn, mostly cached. There are no extra AI calls unless you send a follow-up too late for it to be folded into the current answer.

## What exists vs what is new

| Need | Reused (already in repo at aa5bbc8) | New / changed here |
|---|---|---|
| Streaming turn | `POST /api/ai/threads/[id]/agent` (SSE: delta/tool/reset/done/error), `runAgentTurn` loop (≤6 calls, ≤8 tools, 60 s, 1200 out tokens) | `ack` / `followup` events; loop gets `style`, `memoryFacts`, `extraTools`, `takeFollowUps`, `onFollowUp` |
| Instructions / cache | `agentInstructions()`, `prompt_cache_key cafe-agent-v1` | `STYLE_RULES` appended to the stable prefix; key `cafe-agent-v2` only when style is on |
| Idempotency | `clientMessageId` unique per thread, `getExistingSupervisorReply` replay | job row unique per owner message; `ai_agent_job_start` returns `attached` for duplicates |
| Approval cards | `proposal_card` blocks only from trusted tool results; `SupervisorProposalCard` (3 s poll prior art) | `memory_card` block built the same way; `MemoryCard.tsx` |
| Memory store | `ai_team_rules` + `TeamRulesService` (draft → approve/reject, version check, RLS) | `getRule(id)` + `GET /api/ai/rules/[id]`; active rules loaded into context; `remember_cafe_fact` tool creates drafts only |
| Background work | — | `ai_agent_jobs` table + 4 service-role RPCs (migration `20261023000085`), `after()` keep-alive, `GET /api/ai/threads/[id]/jobs`, `useAgentJobWatcher` (Realtime + poll fallback) |
| Copy | `messages/{en,es,ar}.json` | `ChatExperience` and `MemoryCard` namespaces (same keys in all three, tested) |

Tool names are **unchanged**: the 22 names asserted in `agent.test.ts` remain the default list. `remember_cafe_fact` is passed through `extraTools`, and only when `CHAT_MEMORY` is on. No `checkNumbers` logic was touched.

## Technical design

### 1. Answer style (`CHAT_STYLE_V2`)
`lib/ai/agent/style.ts` holds about 150 tokens of rules. They're appended after the existing instructions, so the prefix stays byte-stable and cacheable. A different cache key (`cafe-agent-v2`) keeps v1 and v2 traffic from evicting each other's cache. `styleReport()` is a count-only check for evals and logs. It never rewrites or blocks a reply.

### 2. Instant acknowledgement + progress (`CHAT_JOBS`)
After the owner message is saved and the job row is created, the route's **first SSE frame** is `ack {jobId, mode}`. The composer shows the ack line straight away. Each `tool` event becomes a progress line (tool label, falling back to the agent label; repeats collapsed; last 6 kept). Steps are also written to `ai_agent_jobs.progress`, in order and best-effort, so a reloaded page can show the same lines. *The ack comes from the server, so the ack and the persisted steps need `CHAT_JOBS`.* With the flag off, the UI looks as it does today.

### 3. Background jobs that survive a reload
- **Table `ai_agent_jobs`.** It has one row per owner message: status `running|done|failed`, `error_code` (required when failed, enforced by a CHECK), `progress jsonb`, `inbox uuid[]`, `consumed uuid[]`, `attempt` and `heartbeat_at`. A partial unique index allows **one running job per thread**. Owners can only read (RLS `owner_user_id = auth.uid()` plus business membership). All writes go through `security definer` RPCs, which are granted to `service_role` only.
- **Start (`ai_agent_job_start`).** If a job already exists for this message, it attaches. If another job is running, the message is appended to that job's inbox (`attached`, or `busy` once the inbox is full). A job left running past 180 s is first marked failed with `timeout`. Otherwise it inserts a new job (`started`). A retry after `failed` re-runs with `attempt+1`, up to 3, then `attempts_exhausted`.
- **Keep-alive.** `keepTurnAlive(work)` uses `after()` from `next/server`. The work promise is created inside the request, and the SSE stream only mirrors it, so a client disconnect never cancels the work (enqueue errors are swallowed). **`maxDuration = 150`** is one 60 s turn plus one continuation (started only if ≥75 s remain), with headroom for persistence. 150 s fits every paid Vercel plan (Hobby allows 60 s, see Risks).
- **Why `after()` and not a queue (QStash, Inngest or SQS).** A turn is at most about 70 s and already streams from this function. `after()` adds no new vendor, secret, webhook or retry semantics, keeps the stream and the work in one place, and costs nothing extra. The job row already gives us idempotency, retries and a stale timeout. A queue becomes worth it if turns must outlive 300 s or run on a schedule.
- **Resume.** `GET /api/ai/threads/[id]/jobs` reads the latest job through the owner's RLS client. Stale rows are shown as `failed/timeout` (`effectiveAgentJob`). `useAgentJobWatcher` subscribes to Realtime `postgres_changes` on `ai_agent_jobs` (`thread_id=eq.`). Each change triggers a re-read through the API, so the socket payload is never trusted. If Realtime errors, times out, closes, or hasn't subscribed within 4 s, it polls every 3 s while the job runs, stopping after 240 s at most. The live turn itself stays on SSE, which respects AGENTS.md "no /progress polling". Polling is only the reload fallback and mirrors `SupervisorProposalCard`.

### 4. Follow-ups while a turn runs
The input stays enabled while a job is live. A follow-up is POSTed like any message and the server attaches it to the running job's inbox. The loop calls `takeFollowUps()` before each model call and after a tools-free answer, while there is work time left (deadline minus 12 s). Follow-ups are capped at 5 per turn and they never add a model call beyond the existing ≤6. Absorbed message ids are saved in `grounding.agentMetadata.absorbedOwnerMessageIds`, so the UI marks them as answered. Late follow-ups (inbox not empty at finish) become a **continuation job**, answered on the same stream or picked up by the watcher after a reload. An inbox read error never fails the turn.

### 5. Per-café memory (`CHAT_MEMORY`)
Memory is the café's **active team rules**. Nothing new is stored. Up to 20 facts are loaded, each at most 300 characters and 2,000 characters in total (about 500 tokens). They're ordered oldest first, so the block is byte-stable and cacheable, and sent as the first `developer` input item. The prompt says facts are background only and never grant permissions. `remember_cafe_fact` (strict schema `{fact, applies_to}`) creates a **draft** only. That means at most one per turn, deduplicated by normalized text, and refused when memory is full. The reply gets a `memory_card` only from that trusted tool result, never from model text. The owner taps Remember or Not now, which sends a versioned PATCH (409 → "changed elsewhere"). Loading failures are non-fatal and logged as codes only.

### 6. Never fail silently
Every failure path ends in a single line from `ChatExperience.failures.*` (en/es/ar). Unknown codes fall back to the generic line. A dropped connection *after* the server confirmed the job is not shown as a failure: the watcher picks the job up. Stale jobs time out after 180 s. Every RPC is idempotent. Logs carry codes only, with no owner text or PII. If the jobs table or RPC is unavailable, the route logs `agent_job_start_failed` and answers inline as it does today.

### 7. Flags
`lib/ai/agent/flags.ts` reads `CHAT_STYLE_V2`, `CHAT_JOBS` and `CHAT_MEMORY` (`1`/`true`), all off by default and server-only. New server modules are dynamically imported only when their flag is on. The full test suite passes with all flags off **and** with all three on.

## Token cost (per turn, gpt-class pricing; cached input ≈ 10% of price)

| Item | Tokens | Cached after 1st call? | Notes |
|---|---|---|---|
| Style rules | ~150 in | yes (stable prefix) | Shorter answers usually *save* 100–300 output tokens |
| Memory block | 0–~500 in | yes (byte-stable, oldest-first) | Only with `CHAT_MEMORY` and only if facts exist |
| `remember_cafe_fact` schema | ~80 in | yes | Only with `CHAT_MEMORY` |
| Ack + progress | 0 | — | Server events, no model involvement |
| Absorbed follow-up | its own text | — | Uses an existing model call; no extra call |
| Continuation | one normal turn | — | Only for follow-ups that arrive too late to be absorbed |

Net effect: input grows by about 230–730 tokens per call, mostly cached. Output tends to shrink. There are no new model calls on the happy path.

## Risks and open points
1. **Vercel plan.** `maxDuration = 150` needs Pro or above (Hobby is capped at 60 s). On Hobby, set it to 60 and continuations will usually move to the next request.
2. **Supabase cookies inside `after()`.** In Next 16, route handlers may read cookies inside `after()`, but a session *refresh* can't write cookies once the response has started. Job RPCs use the admin client. The café tools and memory use the owner's client, which is created before streaming. A token that expires mid-turn (rare within 150 s) would make tool reads fail cleanly with one failure line. Test this on staging.
3. **Realtime publication.** The migration adds the table to `supabase_realtime` only if that publication exists. Otherwise the watcher polls, which works but is slower.
4. **Approving memory = activating a team rule.** If other parts of the app already apply active team rules, approved facts will affect them too. That's intended reuse, but product should confirm it.
5. **SQL verified statically only.** It was parsed with pglast and checked by `agentJobs.migration.test.ts`. Run `supabase db reset` or a staging migration before shipping.
6. **Style compliance is prompt-based.** The model can still drift, so `styleReport` is provided for evals and logs.
7. **Base.** Built on `origin/main` at `aa5bbc8` (PR #158 already merged). Rebase if main has moved.
