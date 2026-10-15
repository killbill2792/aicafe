# AI CAFE — two-person development and review workflow

**Read with [AGENTS.md](../AGENTS.md), [PROGRESS.md](../PROGRESS.md), and the [product roadmap #74](https://github.com/killbill2792/aicafe/issues/74).** This describes *how* the team works; it does not override the approved AI-first owner-outcome contract, authorize actions, or change any production system. For interactive onboarding and checkboxes, use [setup issue #82](https://github.com/killbill2792/aicafe/issues/82).

## 1. Initial GitHub setup — owner only

1. Open [repository collaborators](https://github.com/killbill2792/aicafe/settings/access); confirm the teammate accepted the invite and both GitHub users have 2FA enabled. Do not share accounts or tokens.
2. The repository was verified **private** on 2026-10-15; **keep it private** and exclude customer, payroll, token, real purchase-order, and production data from branches and AI environments. A personal-repository collaborator normally has write and merge permissions; treat branch protection as essential.
3. Open [Settings → Branches](https://github.com/killbill2792/aicafe/settings/branches) and create a protection rule for exactly `main` (or verify an equivalent enforced ruleset). Select: **require pull request before merging**, **at least one approval from someone other than the author**, **dismiss stale approvals**, ideally **require approval of the most recent reviewable push**, **require conversation resolution**, **block force pushes and deletion**, and **no bypass** where available.
4. Require the always-running GitHub Actions check named **`AI CAFE PR baseline`** once that workflow is merged and a successful run exists. Domain-specific workflow jobs may be *path-filtered* and missing on unrelated PRs; don't globally require a status that does not run on every PR. Optionally require up-to-date branch, understanding extra reruns/merge churn. Do not select Vercel preview as a mandatory check while it is rate limited.
5. Verify the protections actually enforce a blocked direct push and an unapproved PR. Do **not** attempt a destructive test or push to protected main.
6. Private repositories owned by personal accounts require an eligible GitHub plan for enforced branch protection (check your plan/UI). **Never make the repo public just to activate protection**; consider upgrading or moving to a suitable GitHub Organization with granular team roles. On a personal repository, one required review prevents self-approval but does **not** technically reserve the final Merge button to the owner. Agree that the repository owner alone authorizes merging; if strict technical owner-only merge is required, use organizational permissions.
7. Keep **Allow auto-merge** disabled in Settings → General; verified disabled at this handoff. Never give Codex or a collaborator production Vercel/Supabase credentials or authorization to change billing, payroll, POS, purchase, RLS or migrations.

This GitHub connection cannot edit/read branch-protection admin settings; the owner must verify them in GitHub.

## 2. Two independent ChatGPT / Codex identities

Each person connects *their own* GitHub identity in ChatGPT/Codex, and uses an authorized `aicafe` Codex environment. Connecting GitHub in ChatGPT doesn't by itself guarantee that the Codex coding environment has repository access or is provisioned.

- Go to [Codex](https://chatgpt.com/codex), connect GitHub if prompted, authorize the relevant repository, and create/select the project environment. Ensure `npm ci` and Node 22 are available. No real café records, production tokens, unrestricted network credentials or live DB service-role access.
- Test access separately: identify latest `main` SHA and open PRs; read `AGENTS.md`, relevant architecture and #74; create an isolated **documentation-only** test branch and draft PR, inspect checks, then close the test PR without merging.
- Each account/coding task uses its own branch/worktree. Starting a new Codex task does not guarantee access to a different task's uncommitted changes; push and reference a PR before handing off.

## 3. Division of labor and dependency discipline

**Owner lane:** Universal Supervisor platform P2/P3/P4 and central `lib/ai/` orchestration/permissions. **Teammate lane:** Olivia domain services/PR3, then Alex/Maya/Leo capabilities. This is the initial division, not permission to implement dependent unmerged features out of order.

- Supervisor P2: [PR #79](https://github.com/killbill2792/aicafe/pull/79) remains separate; P3 may integrate only after its P2 prerequisite is merged and reverified.
- P3 open-ended reasoning and new, safely composable owner what-if calculations: [PR #81](https://github.com/killbill2792/aicafe/pull/81) documents mandatory acceptance, with non-negotiable executable follow-up.
- Olivia PR2 optimizer [#77](https://github.com/killbill2792/aicafe/pull/77) merged; teammate may start PR3 from **current main**, building plan versioning, authorized review/publish and related tests; no code dependency on an unmerged Supervisor PR.
- Every task starts with a GitHub issue/assignment recording PR scope, prerequisites, file ownership, owner journey and exclusions. Assign **one primary code owner** per PR.
- Shared `AGENTS.md`, `PROGRESS.md`, `lib/ai/` contracts, domain-facing registry, broad `lib/calc/`, SQL migrations and architecture docs: announce the change and agree who edits them. The owner of the affected central interface handles it; other domain PRs adapt later. Both PRs may append *different* PROGRESS sections but must reconcile newest main before merge.
- Never create different migrations with the same timestamp, run blind production `supabase db push`, or combine draft assignments and actual worked timecards.

## 4. One safe PR from start to finish

1. **Claim** assigned issue. Read `AGENTS.md`, newest `PROGRESS.md`, domain docs, merged dependencies, current `main` and open PRs. State exactly what owners can do when done, and what remains unsupported.
2. **Branch** uniquely from latest `main` (e.g. `feat/olivia-pr3-publish` or `feat/supervisor-p3`). One milestone per branch; no direct edits to `main`. Avoid scope overlap with a live PR.
3. **Code** the real reusable domain capability or Supervisor behavior; no canned owner-question branches or fake end-to-end implementation. Tests include real intended inputs, no POS/manual-only, RLS/tenant isolation, missing evidence, inconsistent prices/wages, replay/races, and related negative paths.
4. **Open draft PR** using [the default PR template](../.github/pull_request_template.md) with specific tests, affected files, genuine end-to-end owner proof, known limitations, and source/feature/DB gates.
5. **Self-review and test:** `npm ci`, `npx tsc --noEmit`, `npm test`, changed-file lint, `npm run build`, `git diff --check` and disposable PostgreSQL/RLS tests when relevant. Check GitHub Actions on **final HEAD**, not yesterday's green commit. Never record skipped tests as passed.
6. **Human independent review:** other teammate reads entire PR and the *latest* `main`/architecture, checks implementation and risks, requests specific changes. AI/Codex code review is supplemental, not a substitute for human approval. Implementer fixes real defects **on the same PR**; reviewer rechecks the new HEAD after fixes.
7. **Approval and merge:** owner explicitly approves merge; no auto-merge, no deployments, migrations or flags as side effects of accepting a feature. Branch rules must be green and real conflicts resolved. If upstream main changed, merge latest main into the PR branch, resolve overlapping edits deliberately, rerun checks and regain approvals if dismissed.
8. **Handoff:** record merged SHA, what actually works, flags/DB still disabled, tests, and next dependency in #74/`PROGRESS.md`. Next branch always starts from new main.

## 5. Red flags: do not approve

- New special-case global chat intent/switch for each example owner question instead of extensible authorized capabilities.
- An "AI analysis" that contains hardcoded placeholder answers or free-form model-generated SQL, code or financial arithmetic instead of vetted calculations.
- "Done" without authoritative reread, or model claims of payroll, POS price change, supplier purchase or schedule publication unsupported by domain executor/approval.
- Tests restricted to happy-path mocks, skipped failing CI, unidentified cross-tenant reads, raw customer/payroll/token values in logs, or unreviewed production SQL.
- An unresolved dependency, changed source/fingerprint/selector, unreadable UI or no-POS false zeros.

If the team disagrees on a contract, **pause that shared interface**, record the decision in the issue and continue on independent domain work; do not put incompatible implementations on two branches.

References: [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches), [Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud).
