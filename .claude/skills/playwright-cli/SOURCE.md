# Source: playwright-cli

| | |
|---|---|
| Repository | https://github.com/microsoft/playwright-cli |
| Commit (pinned) | `f50f57905b9fd3dd355330719ddf0687000c9437` |
| Commit date | 2026-11-04 |
| Upstream path | `skills/playwright-cli` |
| License | Apache-2.0 |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block (localhost and seeded test cafés only; no attach to real browsers; pinned Playwright).
- Removed `references/pr-attachments.md`, the SKILL.md "Attaching screenshots and videos to pull requests" section and the link to it in `references/video-recording.md` (they post to GitHub with `gh`).
- Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
