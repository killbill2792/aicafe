# Source: gha-security-review

| | |
|---|---|
| Repository | https://github.com/getsentry/skills |
| Commit (pinned) | `0c464f411bdfb8d4c12314b36264d06cb2f60270` |
| Commit date | 2026-11-02 |
| Upstream path | `skills/gha-security-review` |
| License | Apache-2.0 (LICENSE included; the repo has no NOTICE file) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Copied SKILL.md and all of `references/` unchanged. The attack examples there are documentation and are kept as text.
- Checked for Sentry-specific tooling (Sentry CLI, Warden, Seer, internal skills): none in this skill, so nothing removed.
- Added the AI Cafe local rules block. Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
