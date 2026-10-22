# Café Profit — agent instructions (single source of truth; CLAUDE.md only points here)

Read this file fully before any task. If any other doc, PROGRESS entry or code comment conflicts with it, THIS FILE WINS.
Docs marked "historical" in `docs/README.md` describe retired designs. Never implement from them.

## Product
Mobile-first PWA that tells independent café owners how much money they actually kept, and why.
Users: owners aged 30–70 (EN/ES/AR, RTL), many not tech-comfortable. Plain language, big numbers, no jargon.
`docs/02-design-system.md` is binding for UI.

## Stack (do not swap without asking)
Next.js 16 App Router + TypeScript strict + Tailwind · Supabase (Postgres, Auth, Storage, RLS on every table)
Vercel PWA · next-intl (en, es, ar) · zod · date-fns(-tz) · Vitest · OpenAI Responses API via `lib/ai/`.
Next.js 16 differs from your training data: read `node_modules/next/dist/docs/` before using framework APIs.

## Non-negotiable rules
1. Money is integer cents. Never floats. Format only at display.
2. All business math lives in `lib/calc/` as pure, tested functions. The LLM and the UI never do arithmetic.
3. Data access lives in `lib/data/` + RLS. The LLM never writes SQL, never sees other tenants, never writes to the POS.
4. Estimated vs actual is always labeled. Unknown is never shown as zero.
5. All owner-facing strings are in `messages/{en,es,ar}.json`. Never fall back to an unrelated key.
6. Never log tokens, bank lines, receipts, prompts with PII, or API keys.
7. Accessibility: WCAG AA, 48px targets, 17px min body text, reduced motion.
8. Use `docs/05-calculations.md` fixtures as tests; if a test disagrees with the doc, stop and ask.
9. Never ask for bank or POS passwords; OAuth or user-downloaded files only. Encrypt POS tokens at rest.
10. Never build anything on the "Don't build" list in `docs/01-product.md`.
11. Progressive disclosure on owner screens: answer first, details behind an intentional reveal; never show internal enums/model/token/cost telemetry.

## AI architecture (current, binding)
One conversational agent, like a good chat assistant. NOT a supervisor/router, NOT persona sub-agents, NOT an investigator plus reviewer.

- **Loop:** `lib/ai/agent/` (to be created) runs ONE streaming tool-calling loop per owner turn (Responses API, `stream:true`).
  The model writes normal prose and calls tools. Text streams to the client as it arrives.
- **Tools are typed and few:** one tool per business capability, e.g. `get_profit`, `get_sales`, `get_costs`,
  `get_menu_items`, `get_labor`, `simulate_price_change`, `propose_price_change`. Each one has:
  a zod input schema exported as strict JSON Schema (`strict:true`), a handler that calls `lib/data` + `lib/calc`,
  and a COMPACT result (≤ ~1.5k tokens: totals, top rows, ids, units, source + period, `missing[]`).
  No `discover_tools`/`read_cafe` meta-tools. No "discover before read" rule.
- **Numbers:** every number the model may state must come from a tool result or the owner's own words.
  After the reply, `lib/ai/agent/checkNumbers.ts` (to be created) compares numbers in the prose against the turn's tool results
  in code (money in cents, locale-aware decimals). A mismatch is logged and the figure is shown with an
  "unverified" chip. Never delete the sentence, never swap in placeholder text, never call a second LLM to review.
- **Status** is computed from tool results only: `complete` if every tool used returned `missing:[]`, otherwise
  `partial` with the specific missing inputs listed. A recovered tool error does not downgrade the answer.
- **Clarifications** are ordinary assistant messages: one specific question, in the owner's language, with optional
  `quick_replies` (chips built from real ids returned by tools). The owner's reply is just the next user message.
  No special `owner_question` card, no `requires_owner_input` state machine, no generic fallback question.
- **Actions:** `propose_*` tools create an inert proposal and render an approval card (preview + Approve/Decline).
  Only the approval endpoint, called by the owner's click, commits. POS price changes stay manual.
- **Rich blocks:** tools may return `display` hints (`metric`, `chart`, `table`). The UI renders them with the
  source and period chip. Labels come from the tool's own localized field map.
- **When the loop must stop** (budget, timeout, provider error): make one final call with `tool_choice:"none"`
  so the model answers from what it has and says plainly what is missing. Never a canned "I couldn't finish…".

## Conversation state
- `ai_threads` / `ai_messages` store every user, assistant and tool message (tool results are stored compact).
- Context sent per turn = system prompt + tool schemas (stable, cacheable) + rolling summary + last 6–8 messages.
- When history exceeds ~6k tokens, a small model updates `ai_threads.summary` (facts the owner stated, open goals,
  chosen items/periods). Business figures are never cached in the summary; tools re-read them.

## Token and latency budget (enforced in code, tested)
- Stable prefix first (system prompt + tools), and `prompt_cache_key = "cafe-agent-v{N}"`. Never put dates, ids or
  per-turn data in the prefix.
- ≤ 6 model calls and ≤ 8 tool calls per turn. Stop after 2 consecutive tool errors. 60s turn deadline.
- `max_output_tokens` ≤ 1200 per call. Tool result ≤ 1.5k tokens. Target ≤ 25k input tokens for a typical question.
- Main model from `SUPERVISOR_OPENAI_MODEL`. A small model handles summaries/titles only.
- Log per turn: calls, tool calls, input/cached/output tokens, latency, end reason.

## UI
- Chat streams over SSE (`useChat`-style). No `/progress` polling. Tool calls show as small inline status chips.
- Personas (Alex/Olivia/Maya/Leo) are labels/avatars on tool chips only, not separate agents or prompts.

## Do NOT (these designs were tried and retired, so never resurrect or extend them)
- `lib/ai/supervisor/investigation/*` (investigator, reviewer LLM, display-token citations, duplicate/preflight gates,
  `askWhenStuck`, `repeatedTool` copy), the P3 legacy runner, deterministic intent routers, persona sub-agents.
- Rules that ban digits in model text, force every reply to `partial`, or replace model text with generic copy.
- Generic `discover_tools`/`read_cafe` meta-tools, `strict:false` tool schemas, JSON-envelope final answers that
  block streaming.
- Never weaken a test to make it pass. If a test enforces a retired design above, delete it in the same PR and say so.

## Code Review Rules
Block any PR that introduces a reviewer LLM, persona agents, `discover_tools`/`read_cafe` routing,
`strict:false` tool definitions, JSON-envelope assistant answers, `owner_question` cards,
or `/progress` polling. Block tests that fake retries by reusing a call ID instead of
a new call ID for the same logical tool arguments, or tests with vacuous assertions
(e.g. length >= 0). Verify the tool-call/output pairing, all budget boundaries,
database-compatible status values, and honest missing-data behavior before review.

## Where things are
See [docs/README.md](docs/README.md) for current docs and retired historical designs.

## How to work
- One accountable implementer per PR; a separate human reviews; no AI auto-merge.
- Small, scoped PRs: one capability or one concern, ideally < 400 changed lines. State the owner journey it enables.
- Before coding: read this file + only the docs your task needs. Check `PROGRESS.md` "Now" section only.
- Tests: unit tests for every tool handler and `checkNumbers`; recorded-fixture tests for the loop; one live smoke
  script (`npm run smoke:agent` — to be created) run before merge with real credentials by the owner.
- PROGRESS.md keeps three short sections: **Now** (≤ 5 items), **Next**, **Done (last 10)**. Older history goes to
  `docs/history/`. Do not continue unchecked items from history.
- No new dependencies without a one-line reason in the PR. No production migrations, deploys or merges without the
  owner's explicit approval. No AI auto-merge.

## Commands
`npm run dev` · `npm run build` · `npm test` · `npm run lint` · `npx tsc --noEmit` · `npm run db:reset`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
