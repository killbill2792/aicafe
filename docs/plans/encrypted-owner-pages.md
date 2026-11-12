# Encrypted, read-only AI CAFE owner view on existing GitHub Pages

Owner approval: [issue #411, exact nine-file scope](https://github.com/killbill2792/aicafe/issues/411#issuecomment-6810958825), followed by explicit approval in the same AI CAFE conversation. The independent dispatcher overflow fix is PR #446; these code paths do not overlap.

## Data / authority

One source: the private `killbill2792/dave-task-queue/dispatcher/state.json`, with `lifecycle_v3.rows` keyed by signed task ID. Never store a second authoritative task table. Publish only a strict read-only projection with task ID, status, PR/CI/Codex/evidence summaries, next actor/action, dependencies and the two separate ledger and schedule timestamps. Do not publish receipts, ChatGPT conversation URLs, prompts, owner messages or credentials.

## Encryption and authentication

The GitHub Pages server is public, not an authenticated backend. A trusted-main GitHub Actions workflow reads the private ledger through its existing authorized credential and encrypts the allowlisted projection before the site artifact is uploaded. The published file contains only AES-256-GCM ciphertext, salt, IV and PBKDF2 work factor. A long owner passphrase lives **only** in an Actions repository secret `OWNER_PAGES_PASSPHRASE` and the owner's own password manager. No password hash, plaintext JSON, PAT, decryption key or secret is committed.

On the Pages site, enter the password to decrypt locally using the Web Crypto API. The unlocked data is kept in transient page memory and cleared on Lock/reload. A wrong password or modified ciphertext must never show private task data. Password-based static encryption is vulnerable to offline guesses if the passphrase is weak; use a random high-entropy passphrase of at least 24 characters. This is encryption of a publicly retrievable artifact, not HTTP access control. The existing public-safe status page remains public; no write/control API is added.

## Workflow

The new Pages publish workflow runs after successful trusted-main development-dispatcher reconciliation, on a main push when dashboard source changes, or manually. No new five-minute schedule, task producer, database or dispatcher writer. It copies a deliberately allowlisted set of static site files into a temporary Pages artifact and adds `encrypted-owner-snapshot.json` generated from private state. It fails closed if the secret or ledger read is unavailable, and never uploads plaintext.

Owner must set `OWNER_PAGES_PASSPHRASE` under `aicafe` GitHub Actions Secrets, store the same password locally, and select `GitHub Actions` as the Pages build source in repository Settings → Pages if not already selected. The existing private Markdown queue remains available through ordinary GitHub authentication.

## Acceptance

- No plaintext private data in public source, Pages artifact or CI logs.
- Correct strong passphrase decrypts on browser; wrong/empty passphrase and ciphertext tamper fail.
- No privileged dispatcher effects, private ledger API fetch or owner-control POST from Pages.
- Task statuses and stale heartbeat reflect the private ledger exactly, including UNKNOWN.
- Full current-head applicable tests, CI, Codex/security review and owner setup before deployment claims.

## Rollback

Disable the new Pages workflow or restore the previous Pages deployment source and leave the private ledger untouched. Never remove existing signed task state/receipts.
