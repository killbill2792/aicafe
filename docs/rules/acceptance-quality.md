# AI CAFE — Shared real-world Supervisor acceptance protocol

**Status:** The zero-cost scorer calibration is a *test of the test*. It is **not** proof that a live AI model, browser, receipt OCR or café inventory write works. It supplements the existing Promptfoo recorded-event suite (`evals/supervisor/`) and trusted per-PR acceptance runner (`scripts/dev-dispatcher/acceptance-runner.mjs`); it does not replace either.

## What data goes where

| Input / evidence | Source | Key | Retention / authority |
|---|---|---|---|
| Test utterance, expected receipt items, units, costs and intended stock effects | Human-written/owner-reviewed case label, independently checked against an actual receipt or source | suite ID + case ID + source SHA-256 | Synthetic calibration in Git; real receipt labels are private and anonymized |
| Original receipt photograph/PDF | Owner-supplied test upload, explicit consent and redaction | SHA-256 of original bytes + test case ID | Private short-lived test storage, never in repository or public CI logs |
| Observed model text, tool calls, latency, idempotency response | Real Supervisor turn on an explicitly isolated test café | CI run ID + exact head SHA + case ID + model request ID | Redacted CI artifact; runner provides evidence, model does not label itself |
| Persisted inventory readback | Separate authenticated **scoped SQL read**, before and after effect; also verify stock screen | café + ingredient + base unit + observed time + write receipt ID | Ephemeral disposable DB; test never writes live production |
| Subjective conversational quality label | At least one owner-approved human reviewer, blinded to system under test | case ID + rubric revision + reviewer | Secure label set; human agreement/adjudication recorded |
| Comparison to Muse/Grok | Same questions/images under comparable supported permissions | run/case/model versions | Optional. If not performed, parity remains **UNPROVEN** |

**No production tables, log pipelines, auth providers, schedulers, external writes or paid inference are added by this foundation.** The only persistent repo inputs are synthetic calibration JSON; real-world observation files are passed via the acceptance CLI and never committed.

## What every code PR runs automatically

The existing required GitHub `AI CAFE PR baseline` gains one no-secret **Acceptance evaluator integrity** job. It runs the Node built-in test suite and calibration CLI on the checked-out PR head. The aggregator requires success, or requires an explicit expected skip on docs-only changes. It checks that the scorer will reject each deliberately corrupted observation: missing or skipped cases, wrong owner/café, changed receipt bytes, missing DB receipt, false stock totals, duplicate lines, fake success claims, misread item/quantity/unit, over-questioning and impossible timing.

This is **evaluator integrity only**, not real-model acceptance. The existing Promptfoo job and seeded local Playwright/database jobs remain authoritative for their own claims. Other open PRs must rebase after this foundation lands on main; adding a comment or label to an old PR cannot make an old commit have tests it never ran.

## How a real pilot must work (a separate paid/credential approval)

1. Deploy/run the **same actual Supervisor code** as the PR head against a locally migrated, disposable Supabase with two isolated seeded cafés, genuine auth, one owner, and the same registered agent tools. Use a budget-limited real provider API key stored in GitHub secrets; never paste it into chat or run against production. Existing no-provider E2 remains unchanged.
2. Build at least **50 photo/document cases and 30 multi-turn conversation cases**, independently labeled by an owner reviewer before running the model. Mix clear, crumpled, rotated, blurry, duplicate, multi-line and non-delivered documents; receipts with discounts, ambiguous pack sizes and units; corrections; wrong-café access; repeated replay and transient failure. Keep a *held-out* test split not used to tune prompts. Do not silently generate a label from the agent's prediction.
3. For each case, capture the input's file SHA-256, real provider/model/request identity, first-useful-response and completed-operation time, raw tool effect receipts (redacted), **before/after stock rows from independent SQL**, and an actual reopened stock-screen observation. Capture failures and timeouts as executed failures; never drop or skip them.
4. Score objective facts using `node evals/acceptance/cli.mjs --mode live --truth <reviewed-private-labels.json> --observations <trusted-ci-capture.json>`. That mode rejects recorded/synthetic evidence, missing/duplicate cases, missing actual DB readback, unverified effects, insufficient sample size and unproven model identity. It computes p50/p95 **of observed completed duration**, not model-reported timing.
5. Validate the **human wording/interaction judge** before using it. The repository's `validate-evaluator` guidance requires distinct train/dev/held-out cases; aim for at least 50 human Pass and 50 human Fail labels to measure true-positive and true-negative detection. If no calibrated judge, have two humans resolve important conversational disputes. Objective stock changes never depend on a subjective LLM judge.
6. Compare against Muse/Grok only where the same task and permissions exist. Report completion, errors, p50/p95 latency, extraction accuracy and unnecessary questions per model and scenario, plus failure examples. Any category not independently tested must say *UNPROVEN*; do not fill a number with estimates.

## Mandatory fail-closed interpretation

- **No harmful stock writes tolerated.** Wrong business/ingredient/quantity/unit, unapproved stock increase, duplicate receipt or fabricated success is a failure regardless of how fluent the model sounds. A purchase order without received goods is not a receipt.
- **Exact money and stock evidence wins over narrative.** The oracle compares human-labeled expected stock effects with independent scoped before/after readback and durable committed receipt rows. A model saying "Done" is not a database proof. All rows relevant to the scenario must be read; empty/read failure cannot be interpreted as zero stock.
- **Use the same unit and clear provenance.** The test adapter must normalize through the existing canonical ingredient conversion before writing the observation. The scorer requires exact integer quantities in that canonical unit; it must not infer gallon/liter or pack-size conversions.
- **Source integrity and actor boundaries.** The test must hash the *original bytes* before upload; the scorer compares the recorded digest and actor against independent labels. Test another owner and another café, including after permission changes.
- **Completion is not first reply.** Measure first useful response separately from confirmed DB effect and full reply. Any slow/errored attempt counts, even if a later retry succeeds.
- **Review and correction matter.** Owner follow-up questions must be specific. An uncertain item must remain unposted, while independently valid lines may be recorded. A correction to an earlier purchase must not silently create a second positive stock entry.
- **Never self-certify:** A `status=passed` field in a model/tool payload or calibration JSON is ignored. The scorer runs its own objective checks. A JSON observation alone can be fabricated; real acceptance additionally requires a trusted, provenance-bound CI execution receipt and independent human approval.
- **A green integrity job alone never equals a real-model or competitive acceptance.** The CLI's strongest live-mode result explicitly says `objective_checks_pass_subjective_and_provenance_unverified`. Any live full-acceptance claim must separately attach trusted runner evidence, external human-label audit, timing and representative test coverage.

## Integrity and holdout maintenance

When adding a domain (inventory, Gmail, staffing, cash, menu), extend the human-labeled manifest and **introduce an incorrect observation that fails before accepting the new assertion**. Keep one independent source/ground-truth owner from the implementer. Calibrate recorded tests with positive *and* negative examples and never weaken assertions merely to obtain a green run. Any changed evaluator must rerun this mutation suite and have its owner-approved reference labels checked independently. Split/test on new inputs after model or prompt changes. Do not let a test fixture double as production seed data or expose private receipts.

**PR size review note:** This initial foundation keeps expected labels and observed readbacks as separately human-readable JSON fixtures so reviewers can compare every item and stock row. The owner-authorized `big-ok` exception is used for the larger fixture/documentation diff; it does **not** waive executable CI, coverage or review gates.

**Initial calibration:** 8 intentionally synthetic scenarios covering typed purchase, multi-line receipt, unreadable photo, undelivered purchase order, duplicate receipt, cross-café denial, correction and invoice without delivery. Their named ingredient quantities are **test-only** and not business defaults. No real receipts, human holdout, real provider, production effect or competitor timings are bundled.

## Operator command reference

```bash
node --test evals/acceptance/evidence.test.mjs
node evals/acceptance/cli.mjs
# Only with independently reviewed, privately provided live truth and observations:
node evals/acceptance/cli.mjs --mode live --truth /secure/labels.json --observations /secure/capture.json
```

See `AGENTS.md` and `docs/rules/tests.md` for existing owner approvals, merge and no-production rules.
