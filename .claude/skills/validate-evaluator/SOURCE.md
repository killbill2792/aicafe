# Source: validate-evaluator

| | |
|---|---|
| Repository | https://github.com/ai-evals-course/evals-skills |
| Commit (pinned) | `80d5f7b0127c7572ed9e9339937adbfd7240ffeb` |
| Commit date | 2026-09-24 |
| Upstream path | `skills/validate-evaluator` |
| License | Apache-2.0 (LICENSE included) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Replaces the earlier copy from the archived hamelsmu/evals-skills (`22418da`), which was deleted in this PR. This repo is its maintained successor.
- Only these six skills were copied (not evals-start, build-review-interface or evaluate-rag). Left out `agents/openai.yaml` (Codex display metadata).
- Added the AI Cafe local rules block. Added the repo LICENSE (Apache-2.0; the repo has no NOTICE file).
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
