import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conversationUrl, validateAction, prepareLocalState, reserve, getReceipt, markReceipt } from "./state.mjs";
import { probe, submit, localSubmissionAllowed } from "./browser.mjs";
import { configureFirefox, launchFirefox, checkFirefox } from "./firefox.mjs";

const chat = "https://chatgpt.com/c/abc-123";
const claude = "https://claude.ai/chat/abc-123";
const action = { id: "dispatch_001", provider: "chatgpt", conversation_url: chat,
  prompt: "Approved short instruction", approved: true };

function mockDriver(url = chat, { busy = false, editor = true, editorCount = 1, redirectDuringProbe = false } = {}) {
  const calls = [];
  let current = url;
  const driver = {
    calls,
    getCurrentUrl: async () => { calls.push("url"); return current; },
    findElements: async selector => {
      calls.push(["find", selector]);
      const kind = selector.includes("stop-button") ? "busy" :
        selector.includes("composer-text-input") ? "editor" : "none";
      const n = kind === "busy" && busy ? 1 : kind === "editor" && editor ? editorCount : 0;
      if (redirectDuringProbe && kind === "editor") current = "https://chatgpt.com/c/another";
      return Array.from({ length: n }, () => ({ isDisplayed: async () => true }));
    },
  };
  return driver;
}

test("only exact provider conversation URLs and approved IDs are valid", () => {
  assert.equal(conversationUrl("chatgpt", chat), chat);
  assert.equal(conversationUrl("claude", claude), claude);
  for (const url of ["http://chatgpt.com/c/abc", "https://chatgpt.com.evil.org/c/abc",
    "https://chatgpt.com/login", "https://chatgpt.com/c/abc?x=y", "https://chatgpt.com@evil.org/c/abc"]) {
    assert.throws(() => conversationUrl("chatgpt", url), /Conversation URL/);
  }
  assert.throws(() => validateAction({ ...action, approved: false }), /not approved/);
  assert.throws(() => validateAction({ ...action, id: "../other" }), /Invalid action ID/);
});

test("Firefox worker never sends, even with previous Playwright permission switches", async () => {
  assert.equal(localSubmissionAllowed({ AICAFE_BROWSER_ENABLE_SUBMIT: "yes",
    AICAFE_BROWSER_SITE_PERMISSION_CONFIRMED: "yes" }), false);
  await assert.rejects(submit(), /disabled/);
});

test("probe reads URL/controls only and rejects wrong pages, busy chat or missing editor", async () => {
  const good = mockDriver();
  assert.deepEqual(await probe(good, "chatgpt", chat), { ready: true });
  assert.equal(good.calls.every(c => c === "url" || Array.isArray(c) && c[0] === "find"), true);
  const wrong = mockDriver("https://chatgpt.com/login");
  assert.equal((await probe(wrong, "chatgpt", chat)).reason, "wrong_conversation_or_login_required");
  assert.deepEqual(wrong.calls, ["url"]);
  const busy = mockDriver(chat, { busy: true });
  assert.equal((await probe(busy, "chatgpt", chat)).reason, "assistant_busy");
  const missing = mockDriver(chat, { editor: false });
  assert.equal((await probe(missing, "chatgpt", chat)).reason, "composer_missing_or_login_required");
});

test("probe fails closed on ambiguous editors and conversation navigation", async () => {
  await assert.rejects(probe(mockDriver(chat, { editorCount: 2 }), "chatgpt", chat), /Ambiguous/);
  const changed = mockDriver(chat, { redirectDuringProbe: true });
  assert.equal((await probe(changed, "chatgpt", chat)).reason, "conversation_changed");
});

test("Selenium uses a permanent dedicated -profile, not a copied template", async () => {
  const options = { args: [], prefs: [] };
  class Options {
    addArguments(...args) { options.args.push(...args); return this; }
    setPreference(...args) { options.prefs.push(args); return this; }
  }
  const fake = { get: async () => {}, getCurrentUrl: async () => "about:blank" };
  const build = { browser: null, options: null };
  class Builder {
    forBrowser(name) { build.browser = name; return this; }
    setFirefoxOptions(value) { build.options = value; return this; }
    async build() { return fake; }
  }
  const profile = path.join(os.tmpdir(), "aicafe-private-profile");
  const result = await launchFirefox(profile, {
    selenium: { Builder, By: { css: x => x } },
    firefox: { Options },
  });
  assert.equal(build.browser, "firefox");
  assert.deepEqual(options.args, ["-profile", profile]);
  assert.equal(result.driver, fake);
  assert.equal(result.css("div"), "div");
  assert.throws(() => configureFirefox({ Options }, "relative/path"), /absolute/);
});

test("browser check only loads about:blank and rejects an unexpected destination", async () => {
  const calls = [];
  const fake = { get: async x => calls.push(x), getCurrentUrl: async () => "about:blank" };
  assert.equal(await checkFirefox(fake), true);
  assert.deepEqual(calls, ["about:blank"]);
  await assert.rejects(checkFirefox({ ...fake, getCurrentUrl: async () => "https://example.org" }), /did not open/);
});

test("local receipts are exclusive, private and cannot be retried under the same ID", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-browser-test-"));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const dirs = await prepareLocalState(base);
  const receipt = await reserve(dirs.receipts, validateAction(action));
  await assert.rejects(reserve(dirs.receipts, validateAction(action)), e => e.code === "EEXIST");
  assert.equal((await getReceipt(dirs.receipts, action.id)).status, "reserved");
  const updated = await markReceipt(dirs.receipts, receipt, "uncertain", "click may have happened");
  assert.equal(updated.status, "uncertain");
  const disk = await readFile(path.join(dirs.receipts, action.id + ".json"), "utf8");
  assert.equal(disk.includes(action.prompt), false);
  assert.equal(JSON.parse(disk).prompt_sha256.length, 64);
});

test("symlink local profile root is refused", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-browser-symlink-"));
  await rm(base, { recursive: true, force: true });
  await symlink(os.tmpdir(), base);
  t.after(async () => rm(base, { force: true }));
  await assert.rejects(prepareLocalState(base), /Unsafe browser state directory/);
});
