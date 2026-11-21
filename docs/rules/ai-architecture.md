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
