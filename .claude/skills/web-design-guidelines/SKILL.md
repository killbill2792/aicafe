---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - The rules are a fixed copy in [guidelines.md](guidelines.md). Do NOT fetch them from the internet; read that file instead.
> - `docs/02-design-system.md` and AGENTS.md section 8 (WCAG AA, 48px targets, 17px body text) win over any rule here.
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Read the pinned guidelines in [guidelines.md](guidelines.md)
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in guidelines.md
4. Output findings in the terse `file:line` format

## Guidelines Source

AI Cafe keeps a fixed copy in [guidelines.md](guidelines.md) (from `vercel-labs/web-interface-guidelines`, `command.md`, pinned in SOURCE.md). Do not use the upstream URL. The file contains all the rules and output format instructions.

## Usage

When a user provides a file or pattern argument:
1. Read guidelines.md
2. Read the specified files
3. Apply all rules from guidelines.md
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
