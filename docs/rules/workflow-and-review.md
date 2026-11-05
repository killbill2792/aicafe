## 10. How to work
- One accountable implementer per PR.
- Auto-merge when CI is green and the Codex review is clean; PRs must be up to date with main before merging.
- **Small PRs, one concern**, ideally < 400 changed lines. Pure deletions go in their own PR with no
  behavior change. State the owner journey the PR enables.
- Before coding: read this file plus only the docs your task needs, and `PROGRESS.md` "Now".
- Stay in scope. Do not touch files the task does not need. If you find another bug, list it in the PR;
  do not fix it in the same PR unless it blocks the task.
- When you delete a file, update every import, test, script and `.github/workflows/*` that references it.
- **"Done" means:** `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` all pass on the
  final commit, with a link to the green CI run. Do not self-grade with DONE/PARTIAL tables in place
  of that.
- No new dependency without a one-line reason in the PR. No production migrations or deploys
  without the owner's explicit approval.
- `PROGRESS.md` keeps three short sections: **Now** (≤ 5), **Next**, **Done (last 10)**. Older history goes
  to `docs/history/`.

## 11. Review rules
- Block any PR that: adds a reviewer LLM, persona agents or a keyword/intent router; uses `strict:false`
  tool schemas or JSON-envelope answers; rewrites model text outside the exceptions in section 6; adds a
  second reader, calculator, attention list, inbox or experiment system; hard-codes a currency; creates
  a table without RLS; writes to the POS; sends staff/supplier messages directly; or changes tests
  outside the rules in section 9.
- Verify the tool-call/output pairing, all budget boundaries, database-compatible status values and
  honest missing-data behavior.
- First review of a PR: review the whole PR once and report everything in that one review.
- P1 = would hurt a real café owner today: wrong money or numbers, lost or corrupted data, security or
  privacy leaks, broken migrations, crashes, or a main flow that stops working. Post P1s inline. Put every
  P2 and lower in one "P2 list" in the review summary.
- Later reviews: only lines changed since your last review. Raise a new P1 only if those lines caused it.
- When fixing review comments, fix all P1s in one round, re-run all checks, then say it is ready for
  review. Don't fix P2s unless the owner asks.
- Ignore scale edge cases, rare keyboard/screen-reader paths, test wording and style unless they cause a P1.

## 12. Do NOT build (tried and retired, or out of scope for now)
- `lib/ai/supervisor/investigation/*`, P1/P2/P3 runners, deterministic intent routers, persona sub-agents,
  a reviewer LLM, display-token citations, `askWhenStuck`.
- Rules that ban digits in model text, force every reply to `partial`, or replace model text with generic copy.
- Discover-before-read meta tools (`discover_tools`), `strict:false` tool schemas, JSON-envelope final
  answers that block streaming, the `owner_question` card and its state machine, `/progress` polling.
- POS write-back, direct staff/supplier messaging, money movement (see section 2).
- New standalone screens for things the chat can do, and standalone reports that only repeat what the
  POS already shows.
