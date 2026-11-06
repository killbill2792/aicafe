import { conversationUrl } from "./state.mjs";

// Browser DOM is allowed only to confirm the composer and busy state.
// Never inspect or copy assistant replies, conversation history, network payloads, or credentials.
const editors = Object.freeze({
  chatgpt: [
    '[data-testid="composer-text-input"][contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ],
  claude: [
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="true"][role="textbox"]',
  ],
});
const sendButtons = Object.freeze({
  chatgpt: ['[data-testid="send-button"]'],
  claude: ['button[aria-label="Send message"]'],
});
const busyIndicators = Object.freeze({
  chatgpt: ['[data-testid="stop-button"]'],
  claude: ['button[aria-label="Stop response"]'],
});

async function uniqueVisible(page, selectors) {
  for (const selector of selectors) {
    const elements = page.locator(selector);
    const count = await elements.count();
    if (count === 1 && await elements.first().isVisible()) return elements.first();
    if (count > 1) throw new Error("Ambiguous conversation controls; stop safely");
  }
  return null;
}
export async function probe(page, provider, expectedUrl) {
  // Fail closed on redirected sign-in pages, wrong chat, multiple composers, or active model run.
  const canonical = conversationUrl(provider, page.url());
  if (canonical !== conversationUrl(provider, expectedUrl)) throw new Error("Wrong conversation or redirected sign-in");
  const editor = await uniqueVisible(page, editors[provider]);
  if (!editor) return { ready: false, reason: "composer_missing_or_login_required" };
  const busy = await uniqueVisible(page, busyIndicators[provider]);
  if (busy) return { ready: false, reason: "assistant_busy" };
  return { ready: true, editor };
}
export async function submit(page, action, { canSubmit = false } = {}) {
  if (!canSubmit) throw new Error("Live submission is disabled");
  const status = await probe(page, action.provider, action.conversation_url);
  if (!status.ready) return { status: "not_submitted", reason: status.reason };
  await status.editor.fill(action.prompt);
  const button = await uniqueVisible(page, sendButtons[action.provider]);
  if (!button || !await button.isEnabled()) {
    // Text is still only a draft. Do not press Enter or guess another control.
    await status.editor.fill("");
    return { status: "not_submitted", reason: "send_control_unavailable" };
  }
  // The click may have reached the service even if Playwright throws.
  // Caller records submitted_unverified or uncertain; never retries automatically.
  await button.click();
  return { status: "submitted_unverified" };
}
export function localSubmissionAllowed(env = process.env) {
  // Independent switches prevent a copied production action from accidentally sending.
  return env.AICAFE_BROWSER_ENABLE_SUBMIT === "yes" &&
    env.AICAFE_BROWSER_SITE_PERMISSION_CONFIRMED === "yes";
}
