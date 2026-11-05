---
name: graphify
description: Optional code map for AI Cafe. Use only to trace how two known pieces of code connect (route -> server helper -> function) when grep would take several rounds. Local, code-only (no LLM). Not for plain-English "where is X" questions: grep and AGENTS.md "Where things are" are cheaper there.
---

# Graphify (AI Cafe, code-only)

Graphify (PyPI package `graphifyy`, two y's) parses the repo with tree-sitter into `graphify-out/graph.json`
and answers graph questions about it. AI Cafe uses only its local, code-only commands.
Setup, the measured result on this repo and when it is worth it: `docs/rules/skills.md`.
Source and pinned version: [SOURCE.md](SOURCE.md).

## Rules

- Install the pinned version only, in a throwaway virtualenv: `pip install graphifyy==0.9.102`.
- Run it with no API keys in the environment, so it can never send code or docs to a model:
  `env -i PATH="$PATH" HOME="$HOME" graphify update .`
- Never run `graphify install`, `hook install`, `watch`, `clone`, `add <url>`, `label`, `--neo4j-push`,
  `--falkordb-push`, `--mcp` or the `/graphify` assistant pipeline (that one sends docs to a model).
- Never commit `graphify-out/` (about 14 MB here; it is in `.gitignore`).
- Graphify does not read SQL migrations unless the `graphifyy[sql]` extra is installed; for database
  questions read `supabase/migrations/` directly.

## Commands worth using

```bash
graphify path "app/api/cron/daily-brief/route.ts" "briefSchedule()"   # how A reaches B
graphify explain "briefSchedule.ts"                                     # what a file imports and who imports it
```

Treat the output as a lead, then open the files it names. If a query comes back with unrelated nodes,
stop and use grep.
