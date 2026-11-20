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
- **Rich blocks:** existing display hints remain supported. The optional read-only
  `present_response` tool selects versioned compositions from same-turn authorized evidence;
  the server binds exact values, units, currency, date coverage and saved/estimate status.
  No model-supplied executable UI, links, hidden identifiers or new numerical facts.
  The existing message blocks persist the result and the existing chat renderer owns it.
  Full plain-language text is required independently of visuals. Follow-ups edit the
  ordinary composer; existing work, file access and approval paths stay authoritative.
  Report export is a local snapshot of the loaded answer with provenance, not a new saved
  file or independent report pipeline. Scenario alternatives use existing calculator results;
  changing an assumption requests a normal turn, never a business write.
  Optional presentations consume existing model/tool/time allowance. No forced extra round;
  a rejected visual never invalidates the plain answer. The provider schema may omit exact
  duplicate Zod default regexes when the standard format remains; runtime validation is unchanged.
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
- Ordinary turns: ≤ 6 model calls (5 tool rounds + 1 final). When the model actually chooses and executes a supplier-investigation or saved-order-read function, it may use one additional bounded tool round (≤ 7 total model calls including final) to complete the owner\u2019s purchasing workflow; keyword matches and request text must never grant an exception. All turns: ≤ 8 tool executions, stop after 2 consecutive tool errors, and a 60s deadline. The isolated paid pilot also has its separate hard $0.18/18-transport authorization cap.
- `max_output_tokens` ≤ 1200 per call. Target ≤ 25k input tokens for a typical question.
- Main model from `SUPERVISOR_OPENAI_MODEL`; a small model for summaries and titles only.
- Log per turn: calls, tool calls, input/cached/output tokens, latency, end reason. Never log prompt text.
