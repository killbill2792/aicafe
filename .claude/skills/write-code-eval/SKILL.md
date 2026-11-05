---
name: write-code-eval
description: >
  Write code evaluators for known failure modes with objective rules. Use when
  code can check the rule from a trace, with or without a reference answer.
  Use `write-judge-prompt` when the rule requires interpretation.
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - First choice for AI Cafe evals: numbers are checked by code against tool results and `lib/metrics/core` (exact match, `checkNumbers`), tool calls against their strict schemas (`docs/rules/numbers-and-money.md`, `docs/rules/ai-architecture.md`).
> - Code evals live with our Vitest tests or eval scripts and follow `docs/rules/tests.md` (no vacuous assertions, realistic data, no hardcoded café values).
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

# Write a code evaluator

Start with a failure mode found through error analysis. Write one check for that failure mode, much like a unit test that asserts what should hold for each trace.

1. State the rule and identify the trace fields or reference data the check needs. If the rule requires interpretation, use `write-judge-prompt`.
2. Implement the check in the project's language and eval framework. Return a result and a reason in the format that framework expects.
3. Test known passes and failures, including borderline cases. Run the check on available traces and inspect mistakes. If the rule uses a proxy for human judgment, compare its results with human labels.

## Examples

| Failure mode | Possible check |
|---|---|
| Invalid output structure | Parse the output and check required fields |
| Missing or forbidden text | Match a string or pattern |
| Citation not in retrieved documents | Compare cited IDs with retrieved IDs |
| Bad tool call | Check arguments against the tool schema or run the call in a safe test environment |
| Wrong value | Compare the output with a reference value |

Choose the check from the failure rule. For a failure with both objective and interpretive parts, check the objective part with code and use a judge for the rest.
