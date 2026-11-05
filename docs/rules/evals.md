# Supervisor evaluations — zero-cost recorded traces

This suite uses Promptfoo 0.125.1 as a local test runner, **not as an API caller**.
Its TypeScript provider imports the production `runAgentTurn` and supplies
recorded Responses events as the model stream. The Supervisor still runs its
real tool schema, existing read-only tool implementations, core labor
calculations and number-provenance guard on synthetic café-shaped data. There
are no live model calls, paid APIs, secrets, production data reads or writes.

## Run locally

With Node 22 and `npm ci`, from the repository root:

    PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 npm run eval:supervisor

The script checks 13 golden values against an in-memory SQL database
(`verify-truth.mjs`), runs 13 recorded Supervisor turn cases with strict
JavaScript assertions, and prints an explicit skipped-grader notice.
Passing requires **100% of the deterministic tests**. The recorded test
replies are examples of Responses event streams, not newly generated AI
answers; the harness cannot prove that a changed live model or prompt still
produces those responses. Do not claim live-model quality coverage.

## What gets checked

For each case, Promptfoo uses its configured question and a trace in
`replays.json`. The provider rejects a question that differs from the
recorded one, so a test cannot silently keep replaying an old question.
The recorded model calls the production tools on `seed.json` observations.
Assertion functions verify result shapes, source identity, covered periods,
numeric values (money within 1 cent, rates within 0.01 percentage point),
menu item identity, missing wage/unknown inventory handling, and the final
answer's facts. `checkNumbers` remains the production number guard.
Do not relax expectations just to get a green run.

The separate SQL truth file verifies the expected values from fixture
`date`, `netSalesCents`, `wagesCents`, `staffTaxCents` and product
`id`, `priceCents`, `recipeCostCents` and item quantities. Data are
synthetic and tenant-neutral. Currency, time zone and business date come
from the fixture profile; they are not production defaults.

## Add a case

Add anonymized, realistic source facts in `seed.json` and the expected
query result in `sqlTruth`. Update `verify-truth.mjs` with an independent
SQL query. Add a `replays.json` entry: the owner question, recorded strict
tool arguments and the expected final response; give it a unique `caseId`.
Add the matching Promptfoo case and a deterministic JS assertion. Check
that a wrong amount, date, item identity or missing-data claim actually
fails. Never replace an existing failing test with a weaker fixture.

## Wording-only AI grader

Two *optional* wording checks concern clarity and whether the answer is
concise and grounded. The owner authorized only free GitHub Models via the
built-in Actions token, with no other key and no paid provider.
**GitHub retired the Models inference API on July 30, 2026.** Its
`models: read` permission is no longer supported as a callable service,
so `wording-grader.mjs` prints a clear **SKIP** for both optional checks.
It never calls any model, retries a paid endpoint, or converts a skipped
wording check into a factual pass. If GitHub restores an explicitly free
token-only endpoint, review it and its permissions before re-enabling.

GitHub Actions runs the small Supervisor job on changes under `lib/ai/**`
(and an explicit manual workflow dispatch for verification). No API key
is requested. The required baseline stays fail-closed on any failed
deterministic assertion. Actual cost per run: **zero API cost**; CI runner
minutes are separate. Report the measured pass rate and duration from the
green workflow, not from assumed results. There is no `promptfoo share`.

## Limits

Replays verify the integration of the real tool loop and its calculations;
they do **not** exercise live inference or catch a model-only regression.
For a live-model quality gate, a future explicitly approved free inference
service or other owner-approved evaluation approach would be required.
