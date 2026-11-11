# Post-merge Codex P1 repair for dispatcher PR #433

This is one narrow repair to two Codex P1 findings published after PR #433 was owner-merged on 2026-11-11. Do not reopen an existing merged PR or create a second dispatcher.

## Authority and affected paths
- Parent merge: `a989969be3cde19204227cdf3b01c0152d6487d3`
- Review: [PR #433 exact-head Codex review](https://github.com/killbill2792/aicafe/pull/433)
- Edits exclusively: `scripts/dev-dispatcher/scope-authority.mjs`, `scripts/dev-dispatcher/scope-authority.test.mjs`.
- Existing signed queue, private ledger, Muse authenticated receipts, issue #411 scope-plan comments, branch readiness, CI, Codex and owner-merge rules are unchanged.

## Problems and exact fixes
1. **Latest exact-file plan can be lost.** When issue #411 comments leave GitHub's last-100 comment window, select the newest valid previously verified `scope_plan_review` notice (by source comment timestamp and ID), not the first notice in insertion order. Never reinstate a superseded plan or equate an unreviewed comment with authorization. Preserve the exact latest signed scope and its authentication chain.
2. **Revoked scope cannot resume.** After a Muse "no" revokes a not-yet-started coding action, a subsequent authenticated Muse "yes" for the exact plan must restore the already verified planning conversation and transition back through existing `revalidateQueuedActions` to an eligible `proposed` coding assignment. Do not bypass exact scope/hash checks, resurrect a claimed/uncertain sent action, duplicate browser prompts, or change an integrated-proven record.

## Deterministic red-to-green proof
- Two submitted scope-plan notices for the same proposed task; newer corrected plan owner-approved; GitHub fetch window empty; newer plan remains selected and signed, old comment cannot replace it.
- Initial exact scope yes → signed coding ready → no → blocked and unshipped action canceled → fresh yes → code eligible in **same chat** through one new deterministic action key.
- A claimed/uncertain/submitted coding send cannot be replayed.
- Full exact-head dispatcher tests and PR baseline; Codex requested on final green Ready head, owner merges.

No production effects, Vercel previews, new tokens, schedulers, queues, data migrations or PROGRESS.md changes.
