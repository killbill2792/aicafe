# Source: gh-fix-ci

| | |
|---|---|
| Repository | https://github.com/openai/skills |
| Commit (pinned) | `49f948faa9258a0c61caceaf225e179651397431` |
| Commit date | 2026-06-23 |
| Upstream path | `skills/.curated/gh-fix-ci` |
| License | Apache-2.0 (LICENSE.txt) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block.
- Left out `agents/openai.yaml` and `assets/` (Codex display name and icons only).
- `scripts/inspect_pr_checks.py` kept unchanged: it only reads (`gh auth status`, `gh pr checks`, `gh run view`, `gh api` GET).
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
