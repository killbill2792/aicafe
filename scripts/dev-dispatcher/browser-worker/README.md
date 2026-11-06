# AI CAFE — dedicated laptop development browser worker (Firefox/Selenium)

This worker is **not AI CAFE's app-testing Playwright**. It uses its own `selenium-webdriver` package and the owner's locally installed Firefox through geckodriver, with a **separate persistent Firefox profile**. App E2E tooling and its localhost-only safety rules remain unchanged.

## MacBook Air on macOS 12 (Monterey)

Prerequisites: Node.js 22, npm, local Git repo, installed Firefox (tested manually by owner: Firefox 159.0.1 opens). Selenium Manager resolves the Firefox driver on first launch; this requires internet access. On the owner's Mac, use:

```bash
cd ~/Documents/aicafe
git switch local/browser-worker-setup
git pull --ff-only origin main
cd scripts/dev-dispatcher/browser-worker
npm install
npm run doctor
npm run check
```

**Do not run `npx playwright install` for this worker.** Bundled Playwright browsers reject macOS 12. `npm run doctor` verifies only private local directories, not launch readiness. `npm run check` starts a new, isolated Firefox instance using `~/.aicafe-dev-browser/profile`, visits only `about:blank`, closes it and reports PASS or the actual Selenium/geckodriver error. No provider is contacted and no message is sent.

**If the browser check passes**, manually sign into each provider through that same isolated worker profile:

```bash
node cli.mjs login chatgpt
node cli.mjs login claude
```

A Firefox window will open at that provider's public site. Sign in manually. Press Enter in Terminal *after* authentication; the worker closes its Firefox window normally, preserving the private profile. The regular Firefox profile is **not attached or modified**. Authentication persistence still needs owner confirmation; a fresh login might be required.

After sign-in, check one actual chat URL without reading any messages:

```bash
node cli.mjs probe https://chatgpt.com/c/YOUR-CONVERSATION-ID
node cli.mjs probe https://claude.ai/chat/YOUR-CONVERSATION-ID
```

The `probe` command only checks exact provider URL, idle editor and stop/busy control. It does not read assistant replies or cookies. Current website selectors can change without notice.

## Safety and data

- Browser profile and minimal receipts live at `~/.aicafe-dev-browser/`, not in the Git repository. Keep your Mac login private, encrypted and never sync/export these folders to GitHub or chat.
- The existing receipt format is keyed by unique local action ID; it has status, provider URL, prompt SHA-256 and timestamp, not the raw prompt or chat reply.
- **Sending is disabled in this Firefox repair, even if the old Playwright environment switches are set.** No `send` command, autostart, chat-response reader, GitHub-to-browser dispatch or automatic merge is active. Provider-permitted, reliable live submission requires a separate review and owner-run pilot.
- A saved Firefox profile may be logged out by providers. An OS password prompt, challenge or browser update must be handled manually. Never export browser secrets.
- App testing remains on its own Playwright path and seeded local test data only; it must never use this dedicated login profile.
- If the Selenium browser fails on the real Mac, report the first error output. CI runs mock-only contract tests and cannot prove the macOS 12 driver/platform integration. Do not claim live authentication from a green PR.
- The laptop must be awake and internet-connected during any future unattended local worker operation. It is not a GitHub Codespace or cloud server.
