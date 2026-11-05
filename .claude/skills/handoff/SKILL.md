---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - In cloud sessions, `/tmp` is not visible to the owner: write the handoff to the session scratchpad (or paste it in chat) and give its full path. Never commit it.
> - Start it with: branch, PR link, CI state, what is done and verified, what is left, and which files this PR owns. Reference AGENTS.md, PROGRESS.md and the plan by path instead of copying them.
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
