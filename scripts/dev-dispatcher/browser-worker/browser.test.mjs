import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { conversationUrl, validateAction, prepareLocalState, reserve, getReceipt, markReceipt } from "./state.mjs";
import { prepareHandoff, finishHandoff, checkMacCommands } from "./handoff.mjs";

const chat = "https://chatgpt.com/c/abc-123";
const claude = "https://claude.ai/chat/abc-123";
const action = { id: "dispatch_001", provider: "chatgpt", conversation_url: chat,
  prompt: "Approved short instruction", approved: true };
async function temporaryState(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-handoff-test-"));
  t.after(async () => rm(base, { recursive: true, force: true }));
  return (await prepareLocalState(base)).receipts;
}

test("validates exact approved ChatGPT/Claude URLs, action ID and prompt", () => {
  assert.equal(conversationUrl("chatgpt", chat), chat);
  assert.equal(conversationUrl("claude", claude), claude);
  for (const bad of ["http://chatgpt.com/c/abc", "https://chatgpt.com.evil.org/c/abc",
    "https://chatgpt.com/login", "https://chatgpt.com/c/abc?x=y",
    "https://chatgpt.com@evil.org/c/abc", "https://claude.ai/chat/abc#secret"]) {
    assert.throws(() => conversationUrl("chatgpt", bad), /Conversation URL/);
  }
  assert.throws(() => validateAction({ ...action, approved: false }), /not approved/);
  assert.throws(() => validateAction({ ...action, id: "../other" }), /Invalid action ID/);
  assert.throws(() => validateAction({ ...action, prompt: "" }), /Prompt/);
  assert.throws(() => validateAction({ ...action, provider: "other" }), /Unsupported/);
});

test("handoff only opens the exact browser URL and copies approved prompt; never sends", async t => {
  const receipts = await temporaryState(t), calls = [];
  const bridge = {
    openConversation: async url => calls.push(["open", url]),
    copyPrompt: async text => calls.push(["clipboard", text]),
  };
  const result = await prepareHandoff(receipts, action, bridge);
  assert.deepEqual(result, { id: action.id, provider: action.provider, conversation_url: chat, status: "prepared" });
  assert.deepEqual(calls, [["open", chat], ["clipboard", action.prompt]]);
  const stored = await readFile(path.join(receipts, action.id + ".json"), "utf8");
  assert.equal(stored.includes(action.prompt), false);
  assert.equal(stored.includes("assistant_reply"), false);
  assert.equal(JSON.parse(stored).prompt_sha256.length, 64);
  await assert.rejects(prepareHandoff(receipts, action, bridge), e => e.code === "EEXIST");
  assert.equal(calls.length, 2, "a duplicate must not open browser or touch clipboard");
});

test("validation prevents any browser or clipboard effect", async t => {
  const receipts = await temporaryState(t), calls = [];
  const bridge = { openConversation: async () => calls.push("open"), copyPrompt: async () => calls.push("copy") };
  await assert.rejects(prepareHandoff(receipts, { ...action, approved: false }, bridge), /not approved/);
  await assert.rejects(prepareHandoff(receipts, { ...action, conversation_url: "https://evil.example/c/id" }, bridge), /Conversation URL/);
  assert.deepEqual(calls, []);
});

test("failed browser open records an uncertain action and never copies", async t => {
  const receipts = await temporaryState(t), calls = [];
  const bridge = {
    openConversation: async () => { calls.push("open"); throw new Error("OS error"); },
    copyPrompt: async () => calls.push("copy"),
  };
  await assert.rejects(prepareHandoff(receipts, action, bridge), /Handoff interrupted/);
  assert.equal((await getReceipt(receipts, action.id)).status, "uncertain");
  await assert.rejects(prepareHandoff(receipts, action, bridge), e => e.code === "EEXIST");
  assert.deepEqual(calls, ["open"]);
});

test("clipboard failure records uncertain and does not silently retry", async t => {
  const receipts = await temporaryState(t), calls = [];
  const bridge = {
    openConversation: async () => calls.push("open"),
    copyPrompt: async () => { calls.push("copy"); throw new Error("Clipboard unavailable"); },
  };
  await assert.rejects(prepareHandoff(receipts, action, bridge), /Handoff interrupted/);
  assert.equal((await getReceipt(receipts, action.id)).status, "uncertain");
  assert.deepEqual(calls, ["open", "copy"]);
});

test("only explicit owner SENT acknowledges manual click; no automatic delivered claim", async t => {
  const receipts = await temporaryState(t);
  await prepareHandoff(receipts, action, { openConversation: async () => {}, copyPrompt: async () => {} });
  await assert.rejects(finishHandoff(receipts, action.id, "send"), /explicitly/);
  await assert.rejects(finishHandoff(receipts, action.id, "YES"), /explicitly/);
  assert.equal((await getReceipt(receipts, action.id)).status, "prepared");
  const completed = await finishHandoff(receipts, action.id, "SENT");
  assert.equal(completed.status, "owner_confirmed_sent");
  assert.match(completed.note, /not independently verified/);
  await assert.rejects(finishHandoff(receipts, action.id, "SENT"), /already finalized/);
});

test("explicit cancellation and uncertain owner resolution", async t => {
  const receipts = await temporaryState(t);
  await reserve(receipts, validateAction(action));
  const cancelled = await finishHandoff(receipts, action.id, "CANCEL");
  assert.equal(cancelled.status, "owner_cancelled");
  await assert.rejects(finishHandoff(receipts, action.id, "SENT"), /already finalized/);
  await assert.rejects(finishHandoff(receipts, "not_found", "SENT"), /No handoff receipt/);
});

test("existing receipt-safety checks remain strict", async t => {
  const receipts = await temporaryState(t);
  const rec = await reserve(receipts, validateAction(action));
  await assert.rejects(reserve(receipts, validateAction(action)), e => e.code === "EEXIST");
  assert.equal((await getReceipt(receipts, action.id)).status, "reserved");
  await assert.rejects(markReceipt(receipts, rec, "confirmed", "not permitted"), /Invalid receipt/);
  const disk = await readFile(path.join(receipts, action.id + ".json"), "utf8");
  assert.equal(disk.includes(action.prompt), false);
  assert.equal(disk.includes("assistant_reply"), false);
  assert.equal(JSON.parse(disk).prompt_sha256.length, 64);
});

test("symlink local state root is refused", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aicafe-handoff-symlink-"));
  await rm(base, { recursive: true, force: true });
  await symlink(os.tmpdir(), base);
  t.after(async () => rm(base, { force: true }));
  await assert.rejects(prepareLocalState(base), /Unsafe browser state directory/);
});

test("non-Mac platform fails closed without opening a provider", async () => {
  await assert.rejects(checkMacCommands("linux"), /macOS only/);
});
