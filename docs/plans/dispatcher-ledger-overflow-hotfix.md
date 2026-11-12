# Dispatcher v3 private-ledger overflow hotfix

Owner-authorized emergency scope: [issue #411 approval and exact paths](https://github.com/killbill2792/aicafe/issues/411#issuecomment-6811114852).

## Why the dispatcher failed

The private `dispatcher/state.json` exceeded the GitHub Contents API 1 MiB inline content limit; its metadata returned a blob SHA with an empty content field. `GitHubLedger.load()` interpreted that as an invalid response. Fatal-report wake notices then added more bytes per failed run.

## Existing authority / transport

GitHub's existing trusted-main dispatcher is the only writer of task/approval/effect decisions. `killbill2792/dave-task-queue/dispatcher/state.json` stays the sole authoritative ledger. Git uses the existing remote `main` branch and CAS non-force push. Archives, if needed, are private and non-authoritative. Old action/receipt identities and owner approvals must not be changed.

## Design

- Fetch a versioned private Git blob through the Git Trees and Git Blobs endpoints, not inline Contents file data. Its SHA is the same CAS identity used for writes.
- Compact oversized ledgers during trusted Git transactions. Preserve all displaced historical records by placing them in private, immutable-by-reference archive files in the same Git commit before removing them from the primary state. Do not archive pending actions, planned/claimed owner notices or anything with outstanding delivery.
- Limit repeated fatal owner alerts to one incident identity per dispatcher failure class, retaining original evidence.
- Make load diagnostics identify the missing Git object or response shape without exposing private content.
- Keep old read-only Pages and signed queue workflows unmodified.

## Acceptance

Automated GitHub blob mocked reads across >1MiB; bounded private-ledger size with archived records and active preservation; Git local fixture CAS; repeated emergency dedupe; unchanged approval and effect gates; current-head CI/Codex, owner-only merge, then real trusted-main reconcile receipt.

The separately approved nine-file encrypted read-only Pages view is **not part of this PR**.
