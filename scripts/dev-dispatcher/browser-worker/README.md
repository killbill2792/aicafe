# AI CAFE — dedicated laptop browser worker (PR C)

This is **not** the product/browser testing Playwright. It uses its own exact Playwright dependency, headed Chromium, private on-device browser profile and receipt directory. It never opens the AI CAFE app or changes the test Playwright skill. **Not an always-on server**: for unattended operation your laptop must stay awake and connected. GitHub Actions remains the external coordinator.

## Install on your laptop (macOS / Windows / Linux)

Prerequisites: Node.js 22+, Git, terminal and a working graphical desktop. Clone/update `killbill2792/aicafe`, then from the repository root:

```sh
cd scripts/dev-dispatcher/browser-worker
npm install
npx playwright install chromium
npm run doctor
```

On Linux, Chromium may require OS dependencies; follow the exact `npx playwright install` diagnostic instead of modifying product test tooling. The worker's package pins Playwright `1.64.1`; it does **not** use the repo's E2E Playwright installation.

For manual sign-in into this **dedicated** browser profile:

```sh
node cli.mjs login chatgpt
node cli.mjs login claude
```

Sign into each service yourself in the displayed browser. Press Enter in the terminal to close cleanly. The profile is kept under `~/.aicafe-dev-browser/profile` (outside the Git checkout, not in GitHub), and minimal action receipts under `~/.aicafe-dev-browser/receipts`. Use disk encryption, a private OS user account and keep these directories out of cloud-synced folders. Never export profile, cookies, passwords or Google auth to GitHub or chat.

Check one of your existing conversation URLs without reading message contents:

```sh
node cli.mjs probe https://chatgpt.com/c/YOUR-CONVERSATION-ID
node cli.mjs probe https://claude.ai/chat/YOUR-CONVERSATION-ID
```

The probe checks only the exact conversation address, idle composer and visible send area; it does not read assistant replies. The login and composer controls can change as providers change their UI. Real-provider success **has not been demonstrated**; adjust selectors only after an owner-run local test and service permission review.

## Submitting a test prompt (intentionally disabled by default)

The `send` command exists for a future explicitly permitted local test, not for unattended use today. The action file is **private and local**, not a tracked repository file:

```json
{
  "id": "manual_test_001",
  "provider": "chatgpt",
  "conversation_url": "https://chatgpt.com/c/YOUR-CONVERSATION-ID",
  "prompt": "Approved short instruction",
  "approved": true
}
```

**Do not enable sends until the provider's applicable automation permissions have been checked and you have agreed to send in that specific conversation.** Even when the input is approved, `send` additionally requires both local environment switches `AICAFE_BROWSER_ENABLE_SUBMIT=yes` and `AICAFE_BROWSER_SITE_PERMISSION_CONFIRMED=yes`. The worker never gets these switches from GitHub Actions.

To operate after permission review, set both environment variables locally using your OS-specific shell, then run `node cli.mjs send /path/to/private-action.json`. The action ID is uniquely reserved before interacting with the editor. A send click yields only `submitted_unverified`; a failure yields `uncertain`; in either case, it will **not** retry automatically. Check the target chat before deciding whether to send a new action. **No AI reply is read.**

## Boundaries / remaining work

- PR C is a **local browser capability**. It does not poll the dispatcher private ledger, create ChatGPT/Claude chats, discover conversation URLs, decide task priority, read AI answers, send automatic GitHub alerts or merge PRs. PR D owns authenticated coordination and action/receipt transport.
- No user action is needed to review/merge the mocked worker tests. Actual login and service interaction require the owner's laptop and cannot be honestly claimed proven in GitHub CI.
- If the browser returns the wrong page, shows multiple possible editors, is busy, requires login, or has no send button, it fails closed. Browser-profile data and any private action file remain on the laptop; only action IDs/hashes/status may later be transported to GitHub.
- The existing `.claude/skills/playwright-cli/SKILL.md` remains **unchanged** and applies to AI CAFE app tests only. This worker is separately scoped and must not attach to the owner's regular browser. Never use this login profile for test cafés or product E2E.
