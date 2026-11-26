## 6. AI architecture (binding)
One conversational agent with ONE streaming tool-calling loop per owner turn (OpenAI Responses API,
`stream:true`) in `lib/ai/agent/`. NOT a router, NOT persona sub-agents, NOT an investigator plus reviewer.

- **OpenAI is the brain.** The model decides which tools to call, what to ask and how to answer.
  Code does not pre-decide intent with regexes or keyword routers.
- **Tools:** typed, strict JSON Schema (`strict:true`), zod input, compact results (≤ ~1.5k tokens:
  totals, top rows, ids, units, source + period, `missing[]`). One tool per business capability.
  One read-only data-query interface (`describe_data`/`query_data`) and one general
  `calculate` tool remain authoritative. For legacy execution, use only reviewed
  canonical views. The U3 approved target permits model-authored analytical SELECT
  on a **private, catalog-admitted logical business surface only**, after a dedicated
  non-owner/non-BYPASSRLS research role, real PostgreSQL AST admission and independently
  tested database tenant/owner/lease enforcement are deployed. Do not send model SQL
  to service-role clients or SQL SECURITY DEFINER RPCs. The server, never the model,
  chooses the café and owner scope. No arbitrary database SQL, effects or mutation.
- **Clarifications:** the `ask_owner` tool renders a clarify card (2–4 options from real tool data + Other).
  The owner's answer is the next message. No server-side pending-question state.
- **Actions:** `propose_*` tools create an inert proposal and an approval card. Only the approval
  endpoint, called by the owner's click, commits.
- **Presentation is part of the answer, independent of retrieval.** Luna composes ordinary
  streaming Markdown and native inline JSON Render components in one response. The component
  catalog is available for every owner turn, including questions requiring no tool calls.
  Choose the presentation appropriate to the question; never force a chart or a domain-specific
  layout, and never call a second model to format the answer. Use the same renderer, response
  stream, and ordered persisted message blocks. Reasoning summaries replace the active section;
  completed answer parts accumulate.
  Data views bind to exact fields of admitted evidence regardless of how it was retrieved,
  including multiple successful results and exact owner-provided information. Conversation
  history can be displayed as historical context, not automatically promoted to current
  business evidence. For numeric displays retain units, source, coverage, currency and
  uncertainty; never invent values, expose hidden identifiers, or use arbitrary UI code/actions.
  Use the existing calculator for arithmetic and the existing authenticated file and approval
  paths for effects. An invalid visual must not invalidate the plain answer. Report export is
  a local snapshot of the loaded reply. The old `present_response` selection path remains only
  for existing legacy consumers until their approved retirement; do not reintroduce GET tools
  to support presentation. Verify genuine model-selected output and real mobile rendering,
  persistence and interruption recovery before claiming feature acceptance.
- **When the loop must stop** (budget, timeout, provider error): one final call with `tool_choice:"none"`
  so the model answers from what it has and says what is missing.
- **Model text:** never rewrite, replace, shorten or append to the model's reply.
  *Why:* rewrites caused wrong and confusing answers. *Exceptions (only these):*
  1. If a model call fails mid-stream, discard that call's partial text before continuing. It is incomplete.
  2. If the reply is empty and a clarify card was asked, show the card's question as the text.
  3. A blank-line separator between answers to follow-ups that arrived mid-run.
- **Personas** (Alex/Olivia/Maya/Leo) are labels on tool chips only, never separate agents or prompts.

### Owner-approved intelligence-first target (November 20, 2026)

The [remediation record](../plans/universal-supervisor-intelligence-remediation.md)
defines the transition and required evidence. Luna is the intellectual authority
for interactive and unattended objectives: it chooses what to investigate,
which authorized information and capabilities to use, how to assess evidence,
and the appropriate depth of the answer. The application provides reliable data,
canonical calculations, authorization, resource accounting and persistent execution.
Do not encode owner-question strategies, mandatory domain/tool sequences,
preselected conclusions or a second agent. Deterministic observations and schedules
remain useful inputs, never the intellectual decision-maker.

- One existing data access path: discover all permitted business knowledge and
  relationships across POS and non-POS data. Preserve original permitted Toast
  order/object fields and history in the existing operational archive/change log.
  Use source-backed targeted detail and aggregation, not wholesale raw prompt dumps.
  Retain shared metric authority, source periods, freshness and honest unknowns.
  Do not implicitly scan a year of history merely because one requested day is absent.
- Owner-approved U3 production target: **governed PostgreSQL-native analytical SQL**
  (the existing `query_data` façade), not a parallel custom SQL-like query language.
  SQL work is disabled by default until dedicated least-privilege connection, validated
  AST and admitted sources/functions/operators, genuine DB-enforced tenant and field
  protection, read-only transactions, hard resource/cancellation limits, complete
  migrated negative tests and explicit deployment configuration are verified.
  Keep original canonical metric functions and existing operational source lineage.
  Approval to develop and merge U3 does not itself enable a production SQL endpoint,
  authorize paid model runs, or bypass production migration checks.
- Prefer verified provider-native deferred tool discovery and model-selected
  context over full schema repetition. No mandatory custom discover-before-read
  gate or keyword routing. Preserve strict schemas, runtime validation and authorization.
- Resource policy must permit objective-appropriate thinking and final synthesis.
  A simple answer should be quick; a detailed second-store feasibility study may
  need more research, longer reasoning and a substantial sourced answer.
  Replace blanket ceilings only under approved implementation scope, with measured
  budgets and independent tests. Persist work across bounded execution slices instead
  of abandoning it. Never loosen cost, privacy, approval or source safeguards.
- Routines and monitors feed the same persistent Luna work lifecycle; general
  objectives can change strategy as actual evidence changes. Use the existing
  scheduler, effect gateway, verified receipts, follow-up and interruption recovery.
  Do not force corroboration by a fixed number of unrelated domains or tools;
  evidence adequacy depends on the claim, source and uncertainty.
- The target is being implemented in separately approved U1–U5 slices. The runtime and independently executed proof, rather than documentation alone, determine completion.
  Any conflict with AGENTS.md or a binding workflow restriction must be explicitly
  reconciled before affected runtime changes. Exact implementation scope and
  independently executed evidence are mandatory; no production or paid authority.

### Conversation state
- `ai_threads` / `ai_messages` store every user, assistant and tool message (tool results compact).
- Context per turn = stable instructions and permitted tool definitions + existing owner facts and thread memory + recent admitted messages within a 96 KB UTF-8 history budget.
- Owner facts (saved answers) are reused on every turn; never ask again for a saved fact.
- Rolling summary (to be built): a small model keeps facts the owner stated, open goals and chosen
  items/periods. Business figures are never cached in the summary; tools re-read them.

### U2 execution policy (owner-approved implementation)
- Model-led completion, not a preset investigation route. Exact Luna uses provider-native hosted tool search over the existing authorized registry; other models use eager declarations. All selected calls still pass local strict validation, scope and effect authorization.
- Existing 60-second maximum execution slice and tighter worker/lease limits remain. Ordinary Luna permits up to 7 work requests plus one synthesis request, 24 tool calls and 32,768 aggregate output tokens per slice; up to 16,384 work tokens interactively, up to 8,192 per verified migrated worker request and up to 8,192 final reserve. Smaller admitted budgets take precedence. Unknown output reserves its whole admitted cap; final synthesis is tool-free. Durable work uses existing checkpoints and original identity.
- Pre-U2 databases retain the 1,200 worker request ceiling; only the exact migrated service-only capability read permits expansion. Existing fallback and legacy trusted paid-run bounds remain, including the $0.18/18-transport hard cap. No paid launch from a coding approval.
- Existing usage ledgers record redacted request and tool measurements, actual observed model, cached/input/output/reasoning counts and costs when known; missing values are null. Never store prompts, raw reasoning, arguments, results or private business content in telemetry. Production migration and live model execution require separate authorization.
