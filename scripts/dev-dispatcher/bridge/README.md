# Private queue → Dave (OpenClaw), project-neutral bridge

This is **not** a second GitHub dispatcher, an app capability, a browser-click script or a GitHub coding tool. It reads one **private** coordination document created by the existing trusted-main dispatcher, and asks the existing OpenClaw Gateway to use its already authenticated `chrome` extension profile. It never receives GitHub source credentials or checks out AI CAFE.

## Data and boundaries

`docs/plans/universal-supervisor-queue.json` (approved tasks only) + GitHub PR/CI/Codex facts → trusted-main `run.mjs` → **private** ledger repository `dispatcher/state.json` → this one-shot read-only poller on AWS Ubuntu → `openclaw agent` browser navigation → ChatGPT/Claude. The model receives a bounded approved task brief, approved destination/project and action type; it receives **no GitHub token, repository checkout, CI logs or code**. Browser pages can nevertheless contain sensitive code and assistant messages. Tool/browser restrictions must be enforced, not merely requested in a prompt.

- Private ledger: JSON file in separate private GitHub repo; GitHub Contents API, **read-only** token restricted to that repo. No new database or inbound network port.
- Handoff: `version`, `action_id`, `task_id`, `project.id/name`, `provider`, `intent`, approved `prompt`, optional exact `conversation_url`.
- Local receipt: `~/.local/state/dave-handoff/receipts/<sha256(action key)>.json` (0600), containing no prompts, chat replies, cookies, sessions or tokens.
- `--dry-run` by default. Both `--send` and `DAVE_HANDOFF_SEND_ENABLED=1` are required for a live agent turn. Success is `agent_turn_completed_delivery_unverified`, **not** proof the provider accepted the message. Uncertain sends are never automatically replayed.
- No automatic merge, source reads/writes, PR comments or direct code editing.

## Owner setup (once, no new VM)

1. Create a separate **private** GitHub repository with a `main` branch, e.g. `yourname/dave-task-queue`. Leave your public AI CAFE source repository unchanged.
2. Give **AI CAFE GitHub Actions** a fine-grained PAT with Contents **read/write only on that private queue repo**. Store it in AI CAFE's Actions secret `DISPATCH_LEDGER_TOKEN`; set Actions variable `DISPATCH_LEDGER_REPO=yourname/dave-task-queue`. This token is NEVER given to OpenClaw.
3. Run the GitHub Action `AI CAFE Development Dispatcher` manually once with `persist_private_ledger=true`. Verify only `dispatcher/state.json` appeared in the private repository. Then set Actions variable `DISPATCH_LEDGER_AUTO_PERSIST=true` to allow the existing five-minute schedule to update it. If no private ledger is configured, scheduled work remains dry-run.
4. Create a **different fine-grained PAT with Contents read-only** on that same private queue repository. Configure `DISPATCH_LEDGER_READ_TOKEN` and `DISPATCH_LEDGER_REPO` privately for the Ubuntu bridge. **Never** give Dave a token for AI CAFE code.
5. AI CAFE's Supervisor queue currently contains proposed tasks with **empty exact file ownership**. The existing dispatcher correctly refuses to assign these until the owner approves a task's architecture and its exact nonoverlapping owned files. This PR does not approve any task.

## Ubuntu (after PR review/merge)

Copy **only** `scripts/dev-dispatcher/bridge/` onto the Ubuntu host, not the entire AI CAFE checkout. It uses Node.js 22+ (your existing Node 24 suffices), the existing OpenClaw Gateway, and the existing authenticated Chrome extension. No xdotool, xclip, Selenium, Playwright script, new GPU or model install.

With private environment variables `DISPATCH_LEDGER_REPO` and `DISPATCH_LEDGER_READ_TOKEN` available:

```bash
node bridge/cli.mjs --dry-run
```

Only after permission review and a harmless observed pilot, explicitly enable one agent turn:

```bash
DAVE_HANDOFF_SEND_ENABLED=1 node bridge/cli.mjs --send
```

For continuous monitoring, use a user systemd timer that invokes the **one-shot** CLI every 2–5 minutes. Do not enable an unattended timer until a real Ubuntu/browser delivery test succeeds. Idle polls perform only two small GitHub API requests and make **zero NVIDIA model calls**.

## Important security gate

Restrict the effective OpenClaw tools for handoff turns to browser operations: deny `exec`, `process`, `group:fs`, `apply_patch`, code mode and elevated permissions; disable arbitrary browser JS evaluation if unnecessary. Verify policy with `openclaw security audit --deep`. Use a separate restricted agent/session for dispatch if possible. Also keep the Chrome extension in Selected tabs mode.

If the queue reader and OpenClaw run under the **same Ubuntu user**, text instructions and a blocked tool list are not hard OS isolation: for stronger security, install the queue poller as a separate Linux service user with only queue-read access and a narrowly scoped Gateway interface. The browser can still display code and assistant replies from approved tabs; avoid full-page observations that pass them to the model. Check both services' automation rules before sending messages.

## Actual limitations (not falsely marked complete)

- The bridge does **not** yet capture/verify a newly created conversation URL or write an acknowledgement to the ledger. The first new chat must be verified and registered before automated follow-ups can target it.
- Exit code 0 from OpenClaw proves only that the agent turn completed; it does **not** prove ChatGPT/Claude accepted a message. Receipts fail closed and avoid repeat attempts; provider acknowledgement needs a later verified integration.
- This PR does not contact your AWS machine, install/configure tokens, enable sends, deploy services, auto-merge PRs or change the app.
- This worker is project-neutral; AI CAFE is the first producer. Additional project producers can use the same action contract without rebuilding browser navigation.

## Tests

```bash
node --test scripts/dev-dispatcher/delivery.test.mjs scripts/dev-dispatcher/bridge/bridge.test.mjs
```
