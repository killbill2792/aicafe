# Plan: the AI answers any question (owner-approved design, Oct 30 2026)

Status: agreed with the owner on Oct 30 2026. Build it as the small PRs below, in order, one per chat
session. AGENTS.md wins over this file (rule 7.2 already describes this design; it changed in #270).

## What the owner gets

- Any question works without new code: "what if I close on Mondays?", "known costs if ingredients are
  20%?", "which day earns the most per staff hour?". The AI reads the data, decides the method, and every
  sum is done by code, with the steps shown.
- The chat never asks the same thing twice. An answer like "ingredients are 20% for all" is saved once
  and used by every screen and every chat answer, but only where real data is missing.
- The chat always matches the screens for profit, labor cost, card fees, break-even and item cost.

## Rules (from the owner, on top of AGENTS.md)

1. **The AI decides how to answer.** No new tool or scenario per question type. A new tool is added only
   for new data or a new action.
2. **Screen numbers have one definition** in `lib/metrics/core/`: profit, labor cost, card fees,
   break-even, item cost. When an answer needs one, the AI uses the tool that returns it. This list grows
   only when a new number is added to a screen.
3. **Everything else:** the AI reads data with `describe_data` / `query_data` and the read tools, and does
   all arithmetic through ONE `calculate` tool. It knows no money definitions; it only does arithmetic on
   numbers that tools returned or the owner saved.
4. **Owner answers are a fallback, never an override.** Real data wins per day and per item; the owner's
   answer fills only the gaps, labeled estimate, and stops being used as soon as real data exists.
5. **Ask only what the owner can answer:** ingredient %, payroll, bills, card fee %, opening hours. Every
   other gap is a one-line note in the answer, never a question.

## What exists today (checked on main, Oct 30)

- Done: AGENTS.md rule 7.2 (#270). The code no longer turns every gap into a question card; only the AI
  asks (#267). Break-even uses opening hours and stops re-asking known costs (#265).
- Missing: there is **no `calculate` tool** yet, although rule 7.2 refers to it. So the AI cannot do new
  math and falls back to fixed tools or asks the owner.
- `simulate_scenario` (`lib/ai/agent/tools/scenarios.ts`) still has 7 fixed kinds (bill, item price,
  item cost, shift, staff wage, drinks, margin).
- The ingredient % setting exists (`businesses.target_ingredient_cost_rate`, set in
  `lib/actions/supervisorFinancialSettings.ts`, read in `lib/data/supervisorEconomics.server.ts`), but a
  chat answer is not saved into it. Owner answers go through `lib/ownerFacts/` (`answers.ts`,
  `store.server.ts`, `catalog.ts`); unknown facts are saved under keys no tool reads.

## PRs, in order

### PR 1 — The `calculate` tool (start now)

- New `lib/ai/agent/tools/calculate.ts`, registered in `lib/ai/agent/tools/index.ts`.
- Operations: + − × ÷, sum, percent, round. A small parser or a structured expression tree; never
  `eval`/`Function`. Integer cents in, integer cents out for money; division rounds half-even.
- Every input names its source: a tool result from this turn (tool name + field) or a saved owner fact
  key. Inputs the model typed itself are rejected.
- Returns inputs, the formula in plain words, each step, and the result, labeled `calculation` or
  `estimate` (estimate when any input is an estimate).
- Refuses to produce a screen number. If the expression's label or inputs show it is rebuilding profit,
  labor cost, card fees, break-even or item cost, it returns "use the <tool> tool".
- Update the tool's description and the system prompt in `lib/ai/agent/loop.server.ts`: arithmetic only
  through `calculate`.
- Tests: exact arithmetic and rounding; rejected operators and code; rejected unsourced inputs;
  estimate labeling; refusal to rebuild each screen number; `checkNumbers` accepts the returned numbers.

> **Prompt for a new chat:** "Read AGENTS.md and docs/plans/universal-answers.md. Do PR 1 only: the
> `calculate` tool as described there, with its tests. Don't touch other PR scopes. Open a draft PR when
> the AGENTS.md Done checks pass."

### PR 2 — Owner answers saved once, where the calculators read them (after nearby-events PR 2, #279)

- When the owner answers one of the five facts, save it into the field the calculators already read:
  ingredient % → `businesses.target_ingredient_cost_rate` (status `owner`); payroll → payroll extras;
  bills → recurring costs; card fee % → the processing-fee plan; opening hours → business hours.
  No new table or column.
- Readers use it only where real data is missing, per day and per item, labeled estimate (most of this
  already exists in `lib/metrics/core` and `supervisorEconomics.server.ts`; wire the chat answer to it).
- Any other gap becomes a one-line note in the answer, never a question.
- Remove the dead path that saves unknown gaps under keys no tool reads.
- Tests: saving each fact updates the canonical field; a day or item with real data ignores the fact;
  a later turn's numbers use the saved fact.

> **Prompt for a new chat:** "Read AGENTS.md and docs/plans/universal-answers.md. Do PR 2 only: save the
> five owner facts into their canonical fields as described there, with tests. Don't change formulas in
> lib/metrics/core. Open a draft PR when the AGENTS.md Done checks pass."

### PR 3 — Never asked twice (after PR 2)

- A test over a recorded multi-turn conversation: once any of the five facts is saved, no later turn asks
  for it, and "ingredients are 20% for all" stops per-item cost questions.
- Fix only what the test exposes.

> **Prompt for a new chat:** "Read AGENTS.md and docs/plans/universal-answers.md. Do PR 3 only: the
> never-ask-twice test and the smallest fix it needs. Open a draft PR when the AGENTS.md Done checks pass."

### PR 4 — Retire the fixed what-if options (after PR 1, and after #278 and #279 merge)

- Remove `simulate_scenario`'s fixed kinds; what-if questions use the read tools plus `calculate`.
- Keep any screen number it used coming from its core tool.
- Replay the old scenario tests' questions through the new path and show the same numbers.
- Delete the unmerged one-off branch `fix/cost-summary-ingredient-percent`.

> **Prompt for a new chat:** "Read AGENTS.md and docs/plans/universal-answers.md. Do PR 4 only: retire
> simulate_scenario's fixed options as described there, proving the same numbers through calculate.
> Open a draft PR when the AGENTS.md Done checks pass."

## How to run this with new chats

1. Merge the PR that adds this file first, so every new chat reads it from `main`.
2. One Claude Code session per PR, from the latest `main`, using that PR's prompt above.
3. Codex reviews each PR; fix and re-request review in the same session. Merge only with CI green.
4. After each merge, ask the test café a few questions that used to fail (closed Mondays, ingredients 20%,
   labor this month) and check the steps shown.

### Clashes with open work (Oct 30)

| Open PR | Shared files | What to do |
|---|---|---|
| #276 events search | none | Merge any time |
| #277 event readiness | `tools/index.ts`, `agent.test.ts` | Small merge fix; its migration 127 needs the owner |
| #278 web search | `tools/index.ts`, `agent.test.ts`, `loop.server.ts` | Small merge fix; PR 4 waits for it |
| #279 event facts | `tools/index.ts`, `loop.server.ts`, `lib/ownerFacts/answers.ts` | PR 2 and PR 4 wait for it |

When another PR merges first, ask this PR's chat: "Merge main into this branch and fix the conflicts;
keep both sides' tool entries." Keep to at most 4 chats at once.
