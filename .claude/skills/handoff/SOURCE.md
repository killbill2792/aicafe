# Source: handoff

| | |
|---|---|
| Repository | https://github.com/mattpocock/skills |
| Commit (pinned) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` |
| Commit date | 2026-10-31 |
| Upstream path | `skills/productivity/handoff` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block (scratchpad instead of /tmp in cloud sessions). Left out `agents/openai.yaml`. Added the repo LICENSE.
- No setup line in this skill.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
