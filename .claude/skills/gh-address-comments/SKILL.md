---
name: gh-address-comments
description: Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in.
metadata:
  short-description: Address comments in a GitHub PR review
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - In AI Cafe the Codex review is the reviewer. Fix every P1 in one round (`docs/rules/workflow-and-review.md`). Skip the "ask which comments to fix" step when the owner has already said "fix Codex comments".
> - In cloud sessions without `gh`, read comments with the GitHub MCP tools. The script only reads (one GraphQL query). Never resolve, approve or merge on your own.
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

# PR Comment Handler

Guide to find the open PR for the current branch and address its comments with gh CLI. Run all `gh` commands with elevated network access.

Prereq: ensure `gh` is authenticated (for example, run `gh auth login` once), then run `gh auth status` with escalated permissions (include workflow/repo scopes) so `gh` commands succeed. If sandboxing blocks `gh auth status`, rerun it with `sandbox_permissions=require_escalated`.

## 1) Inspect comments needing attention
- Run scripts/fetch_comments.py which will print out all the comments and review threads on the PR

## 2) Ask the user for clarification
- Number all the review threads and comments and provide a short summary of what would be required to apply a fix for it
- Ask the user which numbered comments should be addressed

## 3) If user chooses comments
- Apply fixes for the selected comments

Notes:
- If gh hits auth/rate issues mid-run, prompt the user to re-authenticate with `gh auth login`, then retry.
