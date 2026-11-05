# Source: graphify

| | |
|---|---|
| Repository | https://github.com/Graphify-Labs/graphify |
| Commit (pinned) | `59b5ab1151e031fb42e39cfc9a50bf96f2d57ae0` |
| Commit date | 2026-11-03 |
| Upstream path | `PyPI `graphifyy==0.9.102` (pyproject version at this commit)` |
| License | Apache-2.0 or MIT (dual; LICENSE, LICENSE-MIT, NOTICE upstream) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- No upstream files vendored. `SKILL.md` here is written by AI Cafe: local, code-only use of the CLI.
- Upstream `graphify/skill.md` (800 lines) was not copied: its pipeline clones repos, fetches URLs, pushes to Neo4j/FalkorDB, installs git hooks and sends docs to a model using API keys from the environment (`ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, ...).
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
