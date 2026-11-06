# AI CAFE — manual development-message handoff on Mac

**This is a deliberately assisted workflow, not unattended ChatGPT/Claude automation.** The owner already has ChatGPT signed into **regular Firefox** on macOS 12. Google blocked login inside a Selenium-controlled session. We do not bypass that protection, extract cookies, attach automation to the personal browser, or require password changes.

**The AI CAFE app's test Playwright is entirely separate and unchanged.** This development worker uses only standard macOS `open` and `pbcopy`; no Playwright, Selenium, geckodriver or provider API credentials.

## Install after PR merges (MacBook Air, Monterey)

```bash
cd ~/Documents/aicafe
git switch local/browser-worker-setup
git pull --ff-only origin main
cd scripts/dev-dispatcher/browser-worker
npm install
npm run doctor
npm run check
```

`check` only verifies the macOS native commands. It does **not** open Firefox, log in, access chats, or send a message. On this Mac, start normal Firefox yourself first and verify that the exact ChatGPT/Claude conversation is logged in.

## Prepare one approved message

Create a private local action JSON file **outside the Git repo**, e.g. `~/.aicafe-dev-browser/actions/example.json`. Keep its file permission at `0600`. Replace the URL and prompt with the one you approve:

```json
{
  "id": "manual_pr_followup_001",
  "provider": "chatgpt",
  "conversation_url": "https://chatgpt.com/c/REPLACE_WITH_YOUR_REAL_CONVERSATION_ID",
  "prompt": "Please continue this approved PR work. Follow AGENTS.md and report verified CI and Codex status.",
  "approved": true
}
```

Use `"provider": "claude"` and a matching `https://claude.ai/chat/<id>` link for a Claude chat. The `id` must be **new for every handoff**, not recycled. Never store a private action JSON in GitHub or share it in chat.

From the worker folder:

```bash
node cli.mjs handoff ~/.aicafe-dev-browser/actions/example.json
```

The CLI (1) validates the action and exact official conversation URL, (2) reserves its unique ID in a private minimal local receipt, (3) asks macOS to open that page in the **regular Firefox** profile with `open -a Firefox`, and (4) copies the prompt with `pbcopy`. It **does not paste, press Enter, click Send, read the chat, or see the login**.

**You** must check the correct conversation is visible, press **Command-V**, review the pasted text and **click Send**. Then record what you did:

```bash
node cli.mjs confirm manual_pr_followup_001
```

Type `SENT` at the prompt **only after you actually clicked Send**. The receipt becomes `owner_confirmed_sent`, which is your attestation, **not independent proof of provider delivery**.

If you chose not to send the message:

```bash
node cli.mjs cancel manual_pr_followup_001
```

Type `CANCEL`. To inspect your local record at any time: `node cli.mjs status manual_pr_followup_001`.

After pasting, replace the clipboard contents to avoid leaving the prompt available to other local apps, for example `printf '' | pbcopy`.

## Storage, safety, and limits

- Existing `~/.aicafe-dev-browser/receipts/<id>.json`: only action ID, provider, exact URL, prompt SHA-256, status, timestamp and note. **No raw prompt, answer, password, cookies, browser history or screenshot** in receipts. `prepared` means the browser-open request and clipboard copy succeeded—not that anything was sent.
- Reservations are created **before** OS actions and fail exclusively if an ID is used again. A partially failed handoff becomes `uncertain`; do not auto-retry. Inspect before deciding on a new action. Existing `reserve` and receipt privacy checks remain.
- Existing `~/.aicafe-dev-browser/profile` from the former Selenium worker is **unused**, left untouched. This code does not access, export, migrate or delete it. No fresh profile is created.
- `login`, `probe`, and `send` CLI commands are deliberately retired. No clipboard, browser or network effects happen in CI; isolated tests mock both native OS effects.
- The GitHub dispatcher (PR #385) still monitors work in dry run; there is **no automatic GitHub-to-browser transport or automatic prompt delivery**. Do not represent this as a working unattended 4-ChatGPT/2-Claude system. Any future authenticated automation needs a supported/provider-permitted path and a separate owner-approved, tested design.
- Never put secrets or café-owner data into handoff prompts. The macOS clipboard may be readable by other local software while it holds your text.
