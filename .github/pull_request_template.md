## Owner outcome, plan and scope
- Plan link (owner-approved architecture/implementation plan, or explain N/A):
- Base `main` SHA and merged prerequisites:
- Implementation owner:
- **Owned files (exact paths/globs):**
- Other open PRs touching these files or contracts:
- **What the café owner can accomplish after this PR:**
- **What is still unavailable, default-off or planned for later:**
- **What changed / what was deleted / what was not touched:**

## How it works (plain words)
Explain what runs when, what owns each responsibility, and what can affect in-flight work.
- Data flow: source and fields → one stored record/key → canonical reader/metric → tool/agent → chat/screen.
- Actions: what is only drafted, how the owner approves, what commits, and how it is monitored.
- Unknown, partial or failed inputs, retries, idempotency and rollback (or N/A for docs-only changes).
- Existing official Anthropic/OpenAI or repo skills checked and reused (or why not applicable).
- One-path-per-capability check: which existing paths were extended and which duplicates were retired.

## Implementation and safety
- [ ] Changes stay within the declared owned files; parallel PR overlap checked
- [ ] No hardcoded currency, time zone, café ID/name, dates, prices or scenario-only test values
- [ ] No unapproved migrations, production deploys, POS writes or outbound sends
- [ ] New migration naming/number checked against latest main; RLS and backward compatibility checked (or N/A)
- [ ] No duplicate readers, metric formulas, agent loops, inboxes or experiment paths
- [ ] Existing tests preserved unless a named behavior change requires edits; list each changed test and why

## Verification (record results; do not mark skipped steps as passed)
- Owner scenario → expected result → actual result:
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] Domain/SQL/RLS/integration tests as applicable (or explain N/A)
- [ ] **AI CAFE PR baseline** green on final HEAD
- [ ] Relevant other workflows green on final HEAD
- Test commands/results, blockers and skipped checks:

## Review and merge readiness
- [ ] PR diff and size reviewed; one concern and scoped changes (explain large mechanical moves)
- [ ] Latest main incorporated before merge; migration numbers and parallel dependencies rechecked
- [ ] Codex reviewed the final changes; blocking comments fixed and re-reviewed
- [ ] Final-head CI green
- Auto-merge when CI is green and the Codex review is clean; PRs must be up to date with main before merging.
- Production migrations, deploys and feature activations still require separate owner approval.
