# AWS Ubuntu desktop — guarded ChatGPT input pilot

This is an alternative **X11 adapter** for the existing development browser worker, not a second dispatcher or a replacement for AI CAFE Supervisor. It controls only the already-signed-in Chrome window inside the owner's AWS Ubuntu/Chrome Remote Desktop graphical session. No browser-profile cloning, Selenium login or AI API calls. It does not read assistant replies, conversation text, browser cookies, or network traffic.

**Scope:** one owner-approved, one-time message to an exact existing ChatGPT conversation, using system clipboard paste and Enter. It is not an unattended dispatcher and must not be connected to GitHub Actions until a real AWS pilot verifies targeting and submission. Claude submissions are disabled pending explicit provider permission. OpenAI's consumer terms prohibit automatic/programmatic extraction of output; do not build reply scrapers or bypass provider login, rate limits, CAPTCHA or other restrictions.

## Run from the AWS Ubuntu *graphical desktop* Terminal

Use the already installed and signed-in Chrome. Keep **exactly one Chrome window** open (multiple tabs are fine). Install OS tools:

```bash
sudo apt-get update && sudo apt-get install -y nodejs git xdotool xclip
cd ~/aicafe/scripts/dev-dispatcher/browser-worker
node aws-desktop.mjs doctor
```

If this is the first clone on AWS, `git clone https://github.com/killbill2792/aicafe.git ~/aicafe` first, after the relevant PR is merged. A branch can be checked out for testing before merging; do not trust unreviewed code with private browser accounts.

Open the intended ChatGPT conversation and clear the composer manually. Keep the browser window at the size you will use for the pilot. Run `node aws-desktop.mjs calibrate` from Terminal, then within five seconds point at the **inside of the ChatGPT message editor** without clicking another window. Calibration stores local private X11 coordinates; if the window changes size, it fails closed and must be repeated.

### Easiest live pilot (no action file)

With a signed-in existing ChatGPT conversation open in the single Chrome window, run from the AWS **graphical** Terminal:

```bash
AICAFE_BROWSER_LIVE_SEND=1 node aws-desktop.mjs pilot-current
```

This reads **only Chrome's active address-bar URL**, validates an existing `https://chatgpt.com/c/...` conversation, creates a unique local action ID, and attempts a harmless one-time message asking for `RECEIVED`. **Observe the browser** to confirm the intended chat received it. No screenshots, chat outputs, passwords or session cookies are collected. If the window dimensions changed, recalibrate instead of overriding the check. A receipt of `submitted_unverified` is not proof that the browser accepted a message.

### Advanced explicit-action pilot

Create an approved one-time action file outside the repository (e.g. under `~/.aicafe-dev-browser/`) with mode 0600. It needs: `id` (unique per attempt), `provider: "chatgpt"`, `conversation_url` (exact `/c/…` URL), `prompt` (short, non-sensitive), `approved: true`. Never paste real conversation IDs or account credentials into GitHub commits or chat messages.

Run a single owner-observed pilot in the graphical Terminal:

```bash
AICAFE_BROWSER_LIVE_SEND=1 node aws-desktop.mjs send "$HOME/.aicafe-dev-browser/pilot-action.json"
```

The adapter activates Chrome, navigates to the exact URL, compares the **address bar only**, uses the calibrated editor coordinates, pastes the instruction, and presses Enter. A per-action receipt is stored privately under `~/.aicafe-dev-browser/receipts/`. `submitted_unverified` means only that the keypress occurred, not that ChatGPT accepted it. Never retry an `uncertain` or `submitted_unverified` action automatically. The pilot must be observed in the browser: input might have been pasted into the wrong control due to UI changes. The caller must check that the intended message appeared.

**Not implemented:** extracting AI output; automatic reaction to GitHub; automatic PR merges; autonomous Claude sends; remote AWS deployment. The existing GitHub Actions dispatcher remains read-only. This small pilot is not end-to-end proof of unattended operation.

### Safety and rollback

- Do not open extra inbound security-group ports or expose Chrome debugging connections.
- Do not copy Chrome profiles, cookies, passwords or remote desktop PINs into git or ChatGPT.
- Disable immediately by leaving `AICAFE_BROWSER_LIVE_SEND` unset. Remove only `~/.aicafe-dev-browser/aws-chrome-editor.json` to reset calibration. Existing browser tabs/logins are unaffected.
- The process holds an exclusive `~/.aicafe-dev-browser/aws-desktop-session.lock` during a send. After a crash, check that no desktop worker is running and inspect the pending receipt **before** manually deleting the stale lock. Never auto-delete it.
- Watch the EC2 credit balance; stopping EC2 stops the desktop and its worker. Stopping the EC2 instance does not delete its EBS-backed disk.
