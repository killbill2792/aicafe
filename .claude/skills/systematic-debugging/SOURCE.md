# Source: systematic-debugging

| | |
|---|---|
| Repository | https://github.com/obra/superpowers |
| Commit (pinned) | `22f0b463e7a5e579904dd6211a520321035526f7` |
| Commit date | 2026-11-03 |
| Upstream path | `skills/systematic-debugging` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block.
- `condition-based-waiting-example.ts` is stored as `condition-based-waiting-example.md` (same code in a fenced block) because `tsc --noEmit` type-checks every `.ts` in the repo and its imports point at another project; the link in `condition-based-waiting.md` was updated.
- Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
