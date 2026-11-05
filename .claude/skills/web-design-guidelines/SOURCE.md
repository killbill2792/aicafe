# Source: web-design-guidelines

| | |
|---|---|
| Repository | https://github.com/vercel-labs/agent-skills |
| Commit (pinned) | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` |
| Commit date | 2026-10-27 |
| Upstream path | `skills/web-design-guidelines` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block.
- Upstream fetches its rules at run time from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`. AI Cafe stores a fixed copy as `guidelines.md`, taken from https://github.com/vercel-labs/web-interface-guidelines at commit `434b7f91364665f2f733b310ec54809bf8f37937` (2026-10-05, MIT, LICENSE copied). SKILL.md now reads that file instead of fetching.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
