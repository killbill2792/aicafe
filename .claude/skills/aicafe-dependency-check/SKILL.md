---
name: aicafe-dependency-check
description: Use before assigning, opening, updating, or merging concurrent AI CAFE PRs; prevent stale dependencies, parallel file collisions, wrong branch bases and dead integration code.
---

> **AI CAFE local rules:** AGENTS.md wins. This skill checks code and GitHub state; it is not a second source of truth for what has merged. A closed PR is not necessarily merged or integrated.

# Dependency ownership and parallel work

1. Read latest main `AGENTS.md`, `PROGRESS.md` and the one approved task queue. Resolve task IDs separately from real GitHub PR numbers. Read PR metadata, merged SHA, changed files and actual on-main exports/tests of prerequisites. If prior work only partly passed, link a repair task; do not assume a checkbox proves delivery.
2. **Two distinct gates:** `can_open` if the approved task has a stable prerequisite branch to stack on, exact owned file scope, and no write conflicts. `can_merge` only if prerequisites have landed in main, integrated contracts and tests are verified, latest-head CI/Codex pass, and branch base is updated.
3. Independent work branches from latest main. Dependent work branches from the active prerequisite branch and opens a draft PR against **that branch** immediately. A change to shared registry/schema/module is owned by one foundation PR; other PRs stack on it. Lock exact files and migration numbers for each active task. If a dependency merges while downstream work is underway, rebase/retarget, inspect real changed interfaces and rerun affected tests.
4. After each merge, verify GitHub's actual merged SHA and inspect dependent PRs for stale symbols, unused adapters, duplicate code paths, incompatible migrations or new review findings. Revalidate current main, not old fixture assumptions. Mark a dependency `integrated_proven` only with evidence, not its merge badge.
5. The dispatcher may fill up to **five ChatGPT and two Claude** active slots; start independent tasks or safe stacked drafts without waiting for earlier merges. Never duplicate assignment on webhook retries. Conflicting tasks queue behind their shared-file owner, but unrelated work continues.
6. Shared `PROGRESS.md` changes should be applied by **one coordination owner after merge**, or against latest main with a narrowly scoped patch. Do not have four PRs replace the entire progress file concurrently.

**Existing skills:** `to-tickets`, `incremental-implementation`, `pr`, `two-axis-code-review`; open their SKILL.md only when needed.

**Output table:** task, predecessor PR/branch, predecessor integrated proof, can open now?, base, owned paths, collision, can merge?, next action. Unknown proof is UNKNOWN, never PASS.
