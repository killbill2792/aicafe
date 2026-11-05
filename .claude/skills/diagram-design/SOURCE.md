# Source: diagram-design

| | |
|---|---|
| Repository | https://github.com/cathrynlavery/diagram-design |
| Commit (pinned) | `f24d98b05e2d7a5e68c2dedfe46e5b7173f50118` |
| Commit date | 2026-11-03 |
| Upstream path | `skills/diagram-design (skill version 2.6)` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Only `skills/diagram-design` was used; nothing else from the repo.
- Added the AI Cafe local rules block (data-flow diagrams for PRs and docs, system fonts, skip onboarding).
- System fonts instead of Google Fonts: removed the Google Fonts `<link>` from every vendored template and example; `references/style-guide.md` now says `Font source: system`; `scripts/export_svg.py` `--system-fonts` now defaults to on (`--no-system-fonts` restores the upstream behavior). All vendored HTML passes `python3 scripts/self_check.py --offline`.
- Kept `SKILL.md`, all of `references/`, all of `scripts/` (local Python: standard library only, plus Playwright for `export_png.py`), the five `assets/template*.html` and six examples (data-flow, flowchart, sequence, architecture, state, er). Left out the other 207 example pages, `assets/index.html` (gallery) and `assets/icons.html` to keep the copy small (upstream folder is 5.8 MB). Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
