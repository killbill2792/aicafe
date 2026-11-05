# Source: error-analysis

| | |
|---|---|
| Repository | https://github.com/hamelsmu/evals-skills |
| Commit (pinned) | `22418da2bfb159f28a1b0dcf64e969e14ae56c99` |
| Commit date | 2026-08-15 |
| Upstream path | `skills/error-analysis` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- **The repository is archived/deprecated**: its README says the skills moved to ai-evals-course/evals-skills. We pinned the archived commit the owner chose; do not expect upstream fixes here.
- Added the AI Cafe local rules block. Added the repo LICENSE.
- Only these five skills were copied (not build-review-interface or evaluate-rag).
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
