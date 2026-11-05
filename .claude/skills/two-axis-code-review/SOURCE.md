# Source: two-axis-code-review

| | |
|---|---|
| Repository | https://github.com/mattpocock/skills |
| Commit (pinned) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` |
| Commit date | 2026-10-31 |
| Upstream path | `skills/engineering/code-review` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Renamed (folder and `name:`) from `code-review` to `two-axis-code-review` so it does not clash with Claude Code's built-in `/code-review` skill.
- Replaced every `/setup-matt-pocock-skills` line with: tracker = `docs/plans/` files and GitHub issues; never create issues without the owner's OK.
- Spec search looks in `docs/plans/` and `docs/` instead of `specs/` and `.scratch/`.
- Added the AI Cafe local rules block. Left out `agents/openai.yaml`. Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
