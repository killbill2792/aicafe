# Source: incremental-implementation

| | |
|---|---|
| Repository | https://github.com/addyosmani/agent-skills |
| Commit (pinned) | `301b02b12bff98e4688e6984af6556802322bbde` |
| Commit date | 2026-11-01 |
| Upstream path | `skills/incremental-implementation` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block. Added the repo LICENSE.
- Only this skill and its sibling were copied. `ci-cd-and-automation` was deliberately NOT copied (it recommends auto-merge, which AGENTS.md section 10 forbids). Cross-references to other skills in that repo are not vendored.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
