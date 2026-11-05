# Source: skill-creator

| | |
|---|---|
| Repository | https://github.com/anthropics/skills |
| Commit (pinned) | `ca45fc496a3436251f191354091d557da31c15b5` |
| Commit date | 2026-10-28 |
| Upstream path | `skills/skill-creator` |
| License | Apache-2.0 (LICENSE.txt) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block.
- Removed `scripts/run_eval.py`, `scripts/run_loop.py`, `scripts/improve_description.py` (spawn `claude -p` with the full environment, including credentials, and make model calls), `scripts/generate_report.py` and `assets/eval_review.html` (output loads Google Fonts), and `eval-viewer/` (local HTTP server that kills whatever listens on its port, opens a browser, loads Google Fonts and a CDN script).
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
