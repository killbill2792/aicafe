# Source: vitest

| | |
|---|---|
| Repository | https://github.com/antfu/skills |
| Commit (pinned) | `7de210b51c8d48cc405a4eac3e17cbb1396c653b` |
| Commit date | 2026-10-31 |
| Upstream path | `skills/vitest (generated from vitest-dev/vitest `a5022655`, 2026-10-23, for Vitest 5.1.0-beta.1)` |
| License | MIT (LICENSE.md) |
| Vendored on | 2026-11-05, AI Cafe PR S1 (skills foundation) |

## Safety read
Every SKILL.md, reference and script in this folder was read before copying. Checked for hidden network
calls, credential reads, and anything that pushes, merges, posts or auto-installs.

## Local changes from upstream
- Added the AI Cafe local rules block. Added the repo LICENSE.md.
- **Version check:** AI Cafe runs Vitest **5.0.2** (`package.json` `^5.0.2`, `node_modules/vitest/package.json`). The skill targets 5.1.0-beta.1. Checked against our installed `node_modules/vitest/dist`: `--since-last-run` and `--last-failed` are not in 5.0.2; `--changed`, `--shard` and `--merge-reports` are.
- Also 5.1-only per `references/core-config.md` "v5.1 Additions" (not usable until we upgrade): the `cache` per-file result store (failed/slow files first), `experimental.recordDependencies` and `experimental.vcsProvider`, `ui: { theme }`, `fakeTimers.fakeNodeBuiltins`, `coverage.ignoreNode()`, the multi-project `process.cwd()` change and Browser Mode worker counting.
- Everything else in the references (v5 benchmark fixture, test tags, `aroundEach`, reporters including the `agent` reporter) is described as 4.x/5.0 behavior; still check our installed version before relying on it.
- Trailing whitespace was stripped from copied text files (the PR baseline runs `git diff --check`).

## Updating
Re-vendor from a newer commit only in its own PR: re-read every file, re-apply the changes above, and
update the commit, date and this list.
