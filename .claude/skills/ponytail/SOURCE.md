# Source: ponytail

| | |
|---|---|
| Repository | https://github.com/DietrichGebert/ponytail |
| Commit (pinned) | `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846` |
| Commit date | 2026-10-29 |
| Upstream path | `skills/ponytail` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Verified the clone origin is exactly github.com/DietrichGebert/ponytail.
- Added the AI Cafe local rules block (always on). Added the repo LICENSE.
- Not vendored from this repo: `ponytail-gain` (benchmark scoreboard), `ponytail-help` (describes plugin auto-update, a status band and config files that a vendored copy does not have), hooks, plugin manifests and the pi/gemini/opencode extensions.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
