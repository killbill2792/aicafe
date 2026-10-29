# Café Operator — agent instructions (single source of truth; CLAUDE.md only points here)

Read this file fully before any task. If any other doc, PROGRESS entry, PR description or code comment
conflicts with it, THIS FILE WINS. Docs marked "historical" or "background" in `docs/README.md` are not
instructions. If a rule here blocks the task you were given, stop and ask the owner. Never work around it.

## 1. What we are building
An **AI operator for independent café owners**: one AI assistant (the Supervisor chat) that runs the café
for the owner and reports back. It answers, plans, drafts, monitors and follows up, the way a good
manager or CEO would. The owner decides; the AI does the work.

- **Web app first.** It must work well in desktop and phone browsers. A native phone app comes later.
- **Chat is the product.** The end goal: the Supervisor chat is the only screen an owner needs.
  Existing screens stay until the chat covers them, but every new capability is built for the chat
  first. A screen is optional, never required.
- **Owners:** 30–70 years old, EN/ES/AR (RTL), many not tech-comfortable. Plain words, no jargon.
- **Answer style:** short and direct, like a good chat assistant (think Grok). Answer first, then the
  key number, then one next step. Working and sources go behind "How I got this".

### The operator loop (every capability follows it)
Understand → Answer → Propose → Owner approves → Act → Monitor → Report back.

Examples of the target behavior:
- **Scheduling:** "Make next week's schedule." The AI drafts it from availability, rules and expected
  sales, shows labor cost, the owner approves, and the AI prepares each staff message with a
  WhatsApp/SMS button that the owner taps to send.
- **Price experiment:** "Should I raise the latte 10¢?" The AI shows the current price, margin and
  expected effect (calculated by code). "Run it for 10 days." Owner approves, changes the price in the
  POS and confirms. The AI monitors daily, sends an update if something notable happens, and posts a
  final report with a recommendation.
- **Proactive:** the AI notices a problem (costs up, coverage gap, sales drop, missing data) and tells
  the owner without being asked, with a suggested action.

## 2. What the AI may do (autonomy)
| Level | What | Rule |
|---|---|---|
| Alone | Read data, answer, analyze, compare, simulate what-ifs, draft plans/schedules/messages | Always allowed. Drafts are inert until approved. |
| Owner approves each time | Anything with an effect: publish a schedule, start or stop an experiment, record purchases, staff changes, rule changes, anything that moves money | An approval card (preview + Approve/Decline). Only the owner's click commits. |
| "Always allow" (planned, not built) | Owner may later pre-approve one action type | Must be set by the owner per action type, revocable, logged. Never for money-moving actions unless the owner explicitly turns it on. Do not build until a task asks for it. |
| Not now | Change POS prices or menus; send messages directly to staff or suppliers; move money | POS changes are done by the owner, then confirmed in chat. Messages are copy-ready text plus a WhatsApp/SMS button the owner taps. Direct sending waits until a verified business WhatsApp/SMS sender exists. |

Never claim an action happened unless its tool succeeded. A drafted proposal is not a completed action.

## 3. One system, no duplicates (the most important engineering rule)
The chat and every screen must show the same thing from the same code. Two parallel paths is a bug.
- **One reader per fact** in `lib/data/` (RLS-scoped), used by both screens and chat tools.
- **One calculation per metric** in `lib/metrics/core/` (profit, labor, fees, break-even, margins).
  `lib/calc/` holds other pure helpers; money metrics there are legacy and must be redirected to core,
  never copied.
- **One attention list** (`lib/attention/`), one **experiment/monitoring system**, one **inbox**
  (`operating_tasks`).
- If you find two implementations of the same thing, do not add a third and do not pick one silently.
  Note it in the PR and ask which one survives.
- A screen and the chat showing the same number must have an exact-equality test.

## 4. The Operating Board, inbox and proactive reports
**Operating Board** = the status board at the top of the Supervisor chat (`components/home/ChatStart.tsx`).
It is the owner's single place to see:
1. Key numbers for the chosen period (sales, known costs, kept), with partial/estimate labels.
2. **Needs attention**: items from the shared attention list.
3. **Running**: every active experiment or monitor, with what is being watched, day X of Y, and the
   latest early read.
4. **Recent reports**: finished experiments and proactive findings, each linking to its chat thread.
The board reads the same data as the AI's tools. Never give the board its own query.

**Inbox and notifications.** Every proactive finding, experiment update and final report becomes an
inbox item (`operating_tasks`) and a short chat message in the related thread. The owner sees an
unread count on the board.
- **Channels:** in-app inbox and notification badge now. Email next. Browser push after that.
  WhatsApp/SMS only after a verified business sender exists.
- **Not noisy:** no duplicate alerts for the same finding, a daily cap per café, and the owner can mute
  a type. Every notification says what happened, why it matters (with the number) and the next step.

**Proactive monitors** are scheduled jobs (`app/api/cron/*`). They read the same readers and calculators
as the chat, write inbox items, and post a short report into chat. They never change data owned by
the owner or the POS. They run daily, plus live checks every ~30 minutes while the café is open for
urgent issues (nobody clocked in for a shift, sales far below normal, an item running out, an unusual
void or refund).

## 4b. POS data: keep everything, read everything, include today
- **Keep everything.** Every Toast endpoint the café's credentials allow is captured on a schedule and
  stored (`toast_raw_records`), with customer personal details removed and business data kept.
- **The AI can read all of it** through the canonical views and the one read-only data-query tool, with a
  plain-words dictionary entry for every source. "Missing" means the POS truly returned nothing (or we
  lack permission), and the AI says exactly which.
- **Today counts.** A "today so far" live layer refreshes changed data every 10–15 minutes during open
  hours (orders, payments, time entries, stock, cash). It is labeled provisional and is replaced by the
  final import after closeout. It feeds the same views; it is not a second pipeline.
- Setup data (discounts, tax rates, revenue centers…) refreshes daily.

## 5. Experiments (one lifecycle)
Propose (current price, margin and expected effect from `lib/metrics/core`) → owner approves → owner
makes the POS change and confirms in chat → daily monitoring → mid-run update if notable → final report
with recommendation → owner decides to keep, revert or extend.
- There are two older experiment systems today: the Supervisor loop (`supervisor_proposals`,
  `supervisor_reports`) and owner initiatives (`lib/initiatives/`). They must become one. Until a task
  names which survives, do not extend either with new features.
- Missing or partial data never stops an experiment. The report says what was covered and how
  confident it is.

## 6. AI architecture (binding)
One conversational agent with ONE streaming tool-calling loop per owner turn (OpenAI Responses API,
`stream:true`) in `lib/ai/agent/`. NOT a router, NOT persona sub-agents, NOT an investigator plus reviewer.

- **OpenAI is the brain.** The model decides which tools to call, what to ask and how to answer.
  Code does not pre-decide intent with regexes or keyword routers.
- **Tools:** typed, strict JSON Schema (`strict:true`), zod input, compact results (≤ ~1.5k tokens:
  totals, top rows, ids, units, source + period, `missing[]`). One tool per business capability.
  One read-only data-query tool over documented canonical views is allowed. The server sets the café
  scope; the model never writes SQL and never chooses the café.
- **Clarifications:** the `ask_owner` tool renders a clarify card (2–4 options from real tool data + Other).
  The owner's answer is the next message. No server-side pending-question state.
- **Actions:** `propose_*` tools create an inert proposal and an approval card. Only the approval
  endpoint, called by the owner's click, commits.
- **Rich blocks:** tools may return `display` hints (`metric`, `chart`, `table`) rendered with the source
  and period chip.
- **When the loop must stop** (budget, timeout, provider error): one final call with `tool_choice:"none"`
  so the model answers from what it has and says what is missing.
- **Model text:** never rewrite, replace, shorten or append to the model's reply.
  *Why:* rewrites caused wrong and confusing answers. *Exceptions (only these):*
  1. If a model call fails mid-stream, discard that call's partial text before continuing. It is incomplete.
  2. If the reply is empty and a clarify card was asked, show the card's question as the text.
  3. A blank-line separator between answers to follow-ups that arrived mid-run.
- **Personas** (Alex/Olivia/Maya/Leo) are labels on tool chips only, never separate agents or prompts.

### Conversation state
- `ai_threads` / `ai_messages` store every user, assistant and tool message (tool results compact).
- Context per turn = system prompt + tool schemas (stable, cacheable) + rolling summary + last 6–8 messages.
- Owner facts (saved answers) are reused on every turn; never ask again for a saved fact.
- Rolling summary (to be built): a small model keeps facts the owner stated, open goals and chosen
  items/periods. Business figures are never cached in the summary; tools re-read them.

### Budget (enforced in code and tested)
- Stable prefix first (system prompt + tools), `prompt_cache_key = "cafe-agent-v{N}"`. No dates, ids or
  per-turn data in the prefix.
- ≤ 6 model calls and ≤ 8 tool calls per turn. Stop after 2 consecutive tool errors. 60s turn deadline.
- `max_output_tokens` ≤ 1200 per call. Target ≤ 25k input tokens for a typical question.
- Main model from `SUPERVISOR_OPENAI_MODEL`; a small model for summaries and titles only.
- Log per turn: calls, tool calls, input/cached/output tokens, latency, end reason. Never log prompt text.

## 7. Numbers and money (non-negotiable)
1. Money is integer cents. Never floats. Format only at display.
2. **Code calculates, the AI explains.** All money math lives in `lib/metrics/core/` as pure, tested
   functions. The model never does arithmetic beyond repeating tool numbers.
   *Why:* models make arithmetic mistakes, and owners act on these numbers.
3. Every number the model states must come from a tool result or the owner's own words.
   `lib/ai/agent/checkNumbers.ts` compares them after the reply. A mismatch is logged and the figure gets
   an "unverified" chip. Never delete the sentence and never call a second LLM to review.
4. Estimated vs actual is always labeled. Unknown is never shown as zero.
5. **Always the café's own currency** (`businesses.currency`). Never hard-code `"USD"` anywhere:
   formatting, schemas, checks or defaults. If the currency is missing, show the amount with a
   "currency not set" note.
6. Partial data never blocks an answer. Give the best labeled answer and say exactly what is missing
   (e.g. "based on 5 days of sales").
7. Use `docs/05-calculations.md` fixtures as tests. If a test disagrees with the doc, stop and ask.

## 8. Safety and privacy (non-negotiable)
1. Each café sees only its own data. **RLS is enabled on every table**, with a CI check that fails if any
   `public` table has RLS off. Views use `security_invoker=true` or are service-role only.
2. Service-role keys only on the server, never in client components.
3. The model never writes SQL, never sees other cafés, never writes to the POS.
4. **Every action is logged:** who asked, what was proposed, who approved, what happened, when.
5. Never log tokens, bank lines, receipts, prompts with personal data, or API keys.
6. Never ask for bank or POS passwords. OAuth or owner-downloaded files only. Encrypt POS tokens at rest.
7. All owner-facing strings live in `messages/{en,es,ar}.json`. Never fall back to an unrelated key.
8. Accessibility: WCAG AA, 48px targets, 17px minimum body text, reduced motion. `docs/02-design-system.md`
   is binding for UI.
9. Progressive disclosure: answer first, details behind an intentional tap. Never show internal enums,
   model names, token counts or cost telemetry to owners.

## 9. Tests (rules that stop regressions)
- **Do not edit or delete an existing test unless the task explicitly names that behavior change.**
  The PR must list every test changed or deleted, each with a one-line reason. Any other test change
  is treated as a regression.
- If your change makes an existing test fail, assume your change is wrong first. Fix the code, or stop
  and ask. Never loosen the assertion.
- Test behavior, not source text. Tests that grep source files are allowed only to ban retired imports.
- No vacuous assertions (`>= 0`, `toBeDefined()` alone, `length >= 0`).
- Retries in tests use a new call ID for each new call, never a reused one.
- Unit tests for every tool handler and `checkNumbers`; recorded-fixture tests for the loop.
- **Golden owner questions:** a fixed set of real owner questions on fixture data with exact expected
  numbers, checked on both the chat and screen paths. A PR that changes any golden answer must say why.

## 10. How to work
- One accountable implementer per PR. A separate human reviews. No AI auto-merge.
- **Small PRs, one concern**, ideally < 400 changed lines. Pure deletions go in their own PR with no
  behavior change. State the owner journey the PR enables.
- Before coding: read this file plus only the docs your task needs, and `PROGRESS.md` "Now".
- Stay in scope. Do not touch files the task does not need. If you find another bug, list it in the PR;
  do not fix it in the same PR unless it blocks the task.
- When you delete a file, update every import, test, script and `.github/workflows/*` that references it.
- **"Done" means:** `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` all pass on the
  final commit, with a link to the green CI run. Do not self-grade with DONE/PARTIAL tables in place
  of that.
- No new dependency without a one-line reason in the PR. No production migrations, deploys or merges
  without the owner's explicit approval.
- `PROGRESS.md` keeps three short sections: **Now** (≤ 5), **Next**, **Done (last 10)**. Older history goes
  to `docs/history/`.

## 11. Review rules
- Block any PR that: adds a reviewer LLM, persona agents or a keyword/intent router; uses `strict:false`
  tool schemas or JSON-envelope answers; rewrites model text outside the exceptions in section 6; adds a
  second reader, calculator, attention list, inbox or experiment system; hard-codes a currency; creates
  a table without RLS; writes to the POS; sends staff/supplier messages directly; or changes tests
  outside the rules in section 9.
- Verify the tool-call/output pairing, all budget boundaries, database-compatible status values and
  honest missing-data behavior.
- First review of a PR: review the whole PR once and report everything in that one review.
- P1 = would hurt a real café owner today: wrong money or numbers, lost or corrupted data, security or
  privacy leaks, broken migrations, crashes, or a main flow that stops working. Post P1s inline. Put every
  P2 and lower in one "P2 list" in the review summary.
- Later reviews: only lines changed since your last review. Raise a new P1 only if those lines caused it.
- When fixing review comments, fix all P1s in one round, re-run all checks, then say it is ready for
  review. Don't fix P2s unless the owner asks.
- Ignore scale edge cases, rare keyboard/screen-reader paths, test wording and style unless they cause a P1.

## 12. Do NOT build (tried and retired, or out of scope for now)
- `lib/ai/supervisor/investigation/*`, P1/P2/P3 runners, deterministic intent routers, persona sub-agents,
  a reviewer LLM, display-token citations, `askWhenStuck`.
- Rules that ban digits in model text, force every reply to `partial`, or replace model text with generic copy.
- Discover-before-read meta tools (`discover_tools`), `strict:false` tool schemas, JSON-envelope final
  answers that block streaming, the `owner_question` card and its state machine, `/progress` polling.
- POS write-back, direct staff/supplier messaging, money movement (see section 2).
- New standalone screens for things the chat can do, and standalone reports that only repeat what the
  POS already shows.

## Stack (do not swap without asking)
Next.js 16 App Router + TypeScript strict + Tailwind · Supabase (Postgres, Auth, Storage, RLS on every table)
· Vercel (responsive web app / PWA) · next-intl (en, es, ar) · zod · date-fns(-tz) · Vitest
· OpenAI Responses API via `lib/ai/`. Next.js 16 differs from your training data: read
`node_modules/next/dist/docs/` before using framework APIs.

## Where things are
See [docs/README.md](docs/README.md) for current docs and historical designs.

## Commands
`npm run dev` · `npm run build` · `npm test` · `npm run lint` · `npx tsc --noEmit` · `npm run db:reset`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
