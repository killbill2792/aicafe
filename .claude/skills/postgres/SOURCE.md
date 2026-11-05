# Source: postgres

| | |
|---|---|
| Repository | https://github.com/planetscale/database-skills |
| Commit (pinned) | `f6ed002d03084cb39c01d1d58904d47a36f5322a` |
| Commit date | 2026-10-07 |
| Upstream path | `skills/postgres` |
| License | MIT |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Deleted the "Hosting: PlanetScale" paragraph (vendor recommendation).
- Deleted `references/ps-cli-commands.md`, `ps-cli-api-insights.md`, `ps-connection-pooling.md`, `ps-connections.md`, `ps-extensions.md`, `ps-insights.md` and their SKILL.md rows; the remaining section is renamed "Connection pooling (PgBouncer)".
- Rewrote every `https://raw.githubusercontent.com/planetscale/database-skills/main/...` link in SKILL.md to a local relative path (`references/...`), so nothing is read from the internet or from an unpinned branch.
- Added the AI Cafe local rules block (Supabase rules win). Added the repo LICENSE.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
