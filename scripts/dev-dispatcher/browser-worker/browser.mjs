import { conversationUrl } from "./state.mjs";

// Selenium only inspects the exact conversation URL, editor presence and busy state.
// It never reads assistant replies, conversation history, cookies or network traffic.
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
const busyIndicators = Object.freeze({
  chatgpt: ['[data-testid="stop-button"]'],
  claude: ['button[aria-label="Stop response"]'],
});
async function uniqueVisible(driver, css, selectors) {
  for (const selector of selectors) {
    const found = await driver.findElements(css(selector));
    if (found.length > 1) throw new Error("Ambiguous browser controls: stopped safely");
    if (found.length === 1 && await found[0].isDisplayed()) return found[0];
  }
  return null;
}

export async function probe(driver, provider, expectedUrl, { css = selector => selector } = {}) {
  const expected = conversationUrl(provider, expectedUrl);
  let current;
  try { current = conversationUrl(provider, await driver.getCurrentUrl()); }
  catch { return { ready: false, reason: "wrong_conversation_or_login_required" }; }
  if (current !== expected) return { ready: false, reason: "wrong_conversation_or_login_required" };
  const editor = await uniqueVisible(driver, css, editors[provider]);
  if (!editor) return { ready: false, reason: "composer_missing_or_login_required" };
  if (await uniqueVisible(driver, css, busyIndicators[provider]))
    return { ready: false, reason: "assistant_busy" };
  // A navigation might have occurred during the DOM checks.
  if (await driver.getCurrentUrl() !== expected)
    return { ready: false, reason: "conversation_changed" };
  return { ready: true };
}

// Live send remains unavailable in this Firefox repair, even if someone sets
// the earlier Playwright worker's environment switches. An end-to-end pilot
// and review of provider permissions must precede any new send implementation.
export function localSubmissionAllowed() { return false; }
export async function submit() {
  throw new Error("Live submissions are disabled in the Firefox browser worker");
}
