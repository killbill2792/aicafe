## Owner outcome and scope
- Tracking issue: #
- Implementation owner (GitHub username):
- Reviewer (different person):
- Base `main` SHA / merged prerequisites:
- Domain or subsystem and files owned:
- Other active PRs touching shared contracts:
- **What the café owner can actually accomplish after this PR:**
- **What still cannot be done, is default-off, or needs later phases:**

## Implementation evidence
- [ ] Implements actual production-capable domain code or clearly states when it is a docs-only PR
- [ ] Follows the single streaming agent architecture in AGENTS.md; no investigation/reviewer/router code added or resurrected
- [ ] No new central hardcoded owner-question routing, unauthorized LLM SQL, or fabricated business calculations
- [ ] Source provenance, actual vs assumed vs planned, unknown vs verified zero and money in integer cents remain correct
- [ ] Tenant/user/role scope, sensitive employee/payroll information and permissions validated
- [ ] Missing inputs, invalid data, concurrency and replay/idempotency tested when applicable
- [ ] Changed-file ownership and dependency conflicts checked against current main and open PRs
- [ ] No unapproved production migrations, Vercel/Supabase changes, POS writes or feature flag activation

## Proof and checks (report actual results; don't check skipped tests)
- Owner-facing example request/input → verified result/outcome:
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] ESLint for changed code
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] Domain-specific integration / disposable database / RLS tests (or explain why not applicable)
- [ ] GitHub **AI CAFE PR baseline** check green on **final HEAD**
- [ ] Relevant specialized CI workflows green on final HEAD
- [ ] UI screenshot/preview and EN/ES/AR/mobile review if UI changed (or N/A)
- Test commands/results; actual skipped and blocked checks:

## Safety and release gates
- New SQL migration paths / deployment or rollout needed:
- Source or schema version changes requiring dependent PR updates:
- Known unsupported inputs, assumptions, limitations and rollback:
- [ ] Implementing agent self-reviewed and fixed genuine findings on this same PR
- [ ] A **separate human** reviewed the final diff and approved after latest changes
- [ ] Owner explicitly authorized merge (not presumed from checks)
- [ ] Owner separately authorized any production migration, deployment or flag change

**No AI auto-merge or production activation.** See [team workflow](../docs/team-collaboration.md) and [onboarding checklist #82](https://github.com/killbill2792/aicafe/issues/82).
