import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conversationUrl, validateAction, prepareLocalState, reserve, getReceipt, markReceipt } from "./state.mjs";
import { probe, submit, localSubmissionAllowed } from "./browser.mjs";

const chat = "https://chatgpt.com/c/abc-123";
const claude = "https://claude.ai/chat/abc-123";
const input = { id: "dispatch_001", provider: "chatgpt", conversation_url: chat,
  prompt: "Please continue PR", approved: true };
function mockPage(url = chat, { busy = false, editor = true, button = true, draft = "", navigateOnFill = false } = {}) {
  const calls = [];
  const main = {};
  const listeners = new Set();
  let currentUrl = url;
  return {
    calls, url: () => currentUrl, mainFrame: () => main,
    on: (event, fn) => { if (event === "framenavigated") listeners.add(fn); },
    off: (event, fn) => { if (event === "framenavigated") listeners.delete(fn); },
    locator: selector => {
      const kind = selector.includes("composer-text-input") ? "editor" :
        selector.includes("send-button") ? "send" : selector.includes("stop-button") ? "busy" : "none";
      const count = kind === "editor" && editor || kind === "send" && button || kind === "busy" && busy ? 1 : 0;
      return { count: async () => count, first: () => ({
        isVisible: async () => true, isEnabled: async () => true,
        innerText: async () => draft,
        fill: async value => {
          calls.push(["fill", value]);
          if (navigateOnFill) {
            currentUrl = "https://chatgpt.com/c/another-conversation";
            for (const fn of listeners) fn(main);
          }
        },
        click: async () => { calls.push(["click", selector]); },
      }) };
    },
  };
}
test("only exact approved ChatGPT/Claude chat URLs are accepted", () => {
  assert.equal(conversationUrl("chatgpt", chat), chat);
  assert.equal(conversationUrl("claude", claude), claude);
  for (const bad of ["https://chatgpt.com.evil.com/c/abc", "http://chatgpt.com/c/abc",
    "https://chatgpt.com/login", "https://chatgpt.com/c/abc?secret=1",
    "https://claude.ai/chat/abc#fragment", "https://chatgpt.com@evil.com/c/abc"]) {
    assert.throws(() => conversationUrl("chatgpt", bad), /Conversation URL/);
  }
  assert.throws(() => validateAction({ ...input, approved: false }), /not approved/);
  assert.throws(() => validateAction({ ...input, id: "../escaped" }), /Invalid action ID/);
  assert.throws(() => validateAction({ ...input, prompt: " " }), /Prompt/);
});
test("browser send requires separate explicit local switches", () => {
  assert.equal(localSubmissionAllowed({}), false);
  assert.equal(localSubmissionAllowed({ AICAFE_BROWSER_ENABLE_SUBMIT: "yes" }), false);
  assert.equal(localSubmissionAllowed({ AICAFE_BROWSER_ENABLE_SUBMIT: "yes", AICAFE_BROWSER_SITE_PERMISSION_CONFIRMED: "yes" }), true);
});
test("does not submit if disabled, busy, redirected or send control unavailable", async () => {
  const action = validateAction(input);
  const idle = mockPage();
  await assert.rejects(submit(idle, action), /disabled/);
  assert.equal(idle.calls.length, 0);
  const wrong = mockPage("https://chatgpt.com/c/different");
  await assert.rejects(probe(wrong, "chatgpt", action.conversation_url), /Wrong conversation/);
  const busy = mockPage(chat, { busy: true });
  assert.equal((await submit(busy, action, { canSubmit: true })).status, "not_submitted");
  assert.equal(busy.calls.length, 0);
  const missing = mockPage(chat, { button: false });
  assert.equal((await submit(missing, action, { canSubmit: true })).status, "not_submitted");
  assert.deepEqual(missing.calls, [["fill", action.prompt]]);
});
test("only one selected conversation receives the approved prompt", async () => {
  const page = mockPage();
  const result = await submit(page, validateAction(input), { canSubmit: true });
  assert.equal(result.status, "submitted_unverified");
  assert.deepEqual(page.calls, [["fill", input.prompt], ["click", '[data-testid="send-button"]']]);
});
test("private local receipts are exclusive, do not contain prompt or response and never resend", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-browser-test-"));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const dirs = await prepareLocalState(base);
  const receipt = await reserve(dirs.receipts, validateAction(input));
  await assert.rejects(reserve(dirs.receipts, validateAction(input)), e => e.code === "EEXIST");
  assert.equal((await getReceipt(dirs.receipts, input.id)).status, "reserved");
  const updated = await markReceipt(dirs.receipts, receipt, "uncertain", "click may have happened");
  assert.equal(updated.status, "uncertain");
  const disk = await readFile(path.join(dirs.receipts, input.id + ".json"), "utf8");
  assert.equal(disk.includes(input.prompt), false);
  assert.equal(disk.includes("assistant_reply"), false);
  assert.equal(JSON.parse(disk).prompt_sha256.length, 64);
  await assert.rejects(markReceipt(dirs.receipts, receipt, "confirmed", "fake"), /Invalid receipt/);
});
test("symlink local profile is refused", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-browser-symlink-"));
  t.after(async () => rm(base, { recursive: true, force: true }));
  await rm(base, { recursive: true, force: true });
  await (await import("node:fs/promises")).symlink(os.tmpdir(), base);
  t.after(async () => rm(base, { force: true }));
  await assert.rejects(prepareLocalState(base), /Unsafe browser state directory/);
});

test("preserves user drafts and refuses to send after navigation during fill", async () => {
  const action = validateAction(input);
  const draft = mockPage(chat, { draft: "Do not erase this draft" });
  assert.equal((await submit(draft, action, { canSubmit: true })).reason, "draft_already_present");
  assert.deepEqual(draft.calls, []);
  const navigated = mockPage(chat, { navigateOnFill: true });
  assert.equal((await submit(navigated, action, { canSubmit: true })).reason, "conversation_changed");
  assert.deepEqual(navigated.calls, [["fill", action.prompt]]);
});
