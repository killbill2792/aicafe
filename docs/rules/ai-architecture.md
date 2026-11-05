## 6. AI architecture (binding)
One conversational agent with ONE streaming tool-calling loop per owner turn (OpenAI Responses API,
`stream:true`) in `lib/ai/agent/`. NOT a router, NOT persona sub-agents, NOT an investigator plus reviewer.

- **OpenAI is the brain.** The model decides which tools to call, what to ask and how to answer.
  Code does not pre-decide intent with regexes or keyword routers.
- **Tools:** typed, strict JSON Schema (`strict:true`), zod input, compact results (≤ ~1.5k tokens:
  totals, top rows, ids, units, source + period, `missing[]`). One tool per business capability.
  One read-only data-query tool over documented canonical views is allowed, plus one general
  `calculate` tool for arithmetic (rule 7.2). The server sets the café
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
