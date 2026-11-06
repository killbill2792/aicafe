---
name: aicafe-pr-lifecycle
description: Use for every AI CAFE implementation PR from assignment through merge, especially ChatGPT sessions using the connected GitHub plugin, stacked dependencies, Codex review, CI failures, and rebases.
---

> **AI CAFE local rules:** AGENTS.md always wins. Use the connected GitHub plugin in ChatGPT; read actual repository `AGENTS.md` and `PROGRESS.md` on latest main before code. Do not trust summaries or a previous chat's claim of merge. This skill orchestrates existing `gh-fix-ci`, `gh-address-comments`, `verification-before-completion`, `pr` and `two-axis-code-review` skills; open their SKILL.md only when relevant.

# Own one PR until merged

1. Fetch latest `AGENTS.md`, `PROGRESS.md`, applicable `docs/rules/*` and the approved task brief through the connected GitHub plugin. Load the relevant skills from `docs/rules/skills.md` by opening each applicable `.claude/skills/<name>/SKILL.md`. Verify owner approval for infrastructure and explicit owned/excluded files.
2. Check actual predecessor commits, public exports, changed paths and active PR file overlaps. If independent, start on latest `main`. If dependent on an **open** PR, start from that PR's **branch** and open a **draft stacked PR NOW with base = prerequisite branch**. A dependency not yet merged is **not** a reason to stop opening or coding. Do not edit someone else's owned files.
3. Write the real implementation, smallest changes, no parallel reader/loop/inbox. Add targeted tests proving behavior and failure cases. Use same PR/chat for the entire lifecycle; do not hand off the PR merely because the first iteration is pushed.
4. On every pushed head: inspect actual GitHub CI/check conclusions and logs, fix failed checks; inspect Codex submitted reviews and unresolved inline threads, address each substantive finding, **mark addressed threads resolved** using GitHub plugin and request fresh Codex review. Draft status does not prove review has been requested or completed. Poll while the session remains active; if a review is still pending, report PENDING, not CLEAN or MERGED. Do not invent a timed background process; a dispatcher can re-invoke the same PR ownership task when a GitHub event arrives.
5. Before each merge attempt, check whether any prerequisite merged or `main` advanced **during this PR**. Rebase/retarget stacked PR appropriately after prerequisite merges, verify real integration (imports, registered tools, migrations, canonical read/writer compatibility), recheck file collisions, run required tests on **new final head**, get final-head Codex review.
6. Merge **only** under `AGENTS.md` when current-head CI green, Codex clean, review conversations resolved, mandatory acceptance proven, base current and prerequisites merged. Distinguish optional/skipped checks from passed checks. State merged commit SHA; update the relevant progress entry in a collision-safe way. No production migrations/deploys without owner approval.
7. On actual blocker (secret, owner decision, disallowed scope): keep PR open with precise status and continue independent tasks via dispatcher. Never claim completion because a draft PR exists.

**When to load more:** `gh-fix-ci` for failing CI, `gh-address-comments` and `receiving-code-review` for findings, `supabase` for SQL, `playwright-cli` and `e2e-testing-patterns` for browser behavior, `aicafe-dependency-check` before branching/merge, `aicafe-proof-gate` before marking done.

**Output:** PR URL, branch/base/head SHA, dependency changes since last check, tests actually executed, CI/review state, resolved threads, merge SHA or exact pending blocker.
