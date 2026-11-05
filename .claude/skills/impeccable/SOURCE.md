# Source: impeccable

| | |
|---|---|
| Repository | https://github.com/pbakaus/impeccable |
| Commit (pinned) | `5af4319c4e7a7ee3e5e2b9fe899bcfb21c6190cb` |
| Commit date | 2026-11-04 |
| Upstream path | `.claude/skills/impeccable (skill version 4.8.0, engine 0.1.18)` |
| License | Apache-2.0 (LICENSE, NOTICE.md) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block.
- Removed `scripts/` entirely: the `impeccable` launcher downloads a platform binary from GitHub Releases on first run (a hidden network call that installs an executable), plus `live-browser.js` (563 KB bundle), `modern-screenshot.umd.js` and a 1.1 MB font index used only by the binary and live mode.
- Removed `reference/live.md`, `reference/live-setup.md`, `reference/generate.md` (live browser mode), `reference/hooks.md` (installs an auto-run hook after every UI edit) and `reference/doctor.md` (needs the binary). Some remaining references still link to them; the local rules say to skip those steps.
- Added `slop-rules.md`: the detector's 62 rules (name, id, severity, description) generated from `crates/foundation/src/registry.rs` at this commit, so agents can apply the slop detector as a checklist without the binary.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
