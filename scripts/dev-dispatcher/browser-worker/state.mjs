import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

export const providers = Object.freeze({
  chatgpt: { origin: "https://chatgpt.com", conversation: /^\/c\/[a-zA-Z0-9-]+\/?$/ },
  claude: { origin: "https://claude.ai", conversation: /^\/chat\/[a-zA-Z0-9-]+\/?$/ },
});
export const homeDir = () => path.join(os.homedir(), ".aicafe-dev-browser");
export const receiptDir = () => path.join(homeDir(), "receipts");
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function conversationUrl(provider, rawUrl) {
  const definition = providers[provider];
  if (!definition || typeof rawUrl !== "string") throw new Error("Unsupported provider or conversation URL");
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("Invalid conversation URL"); }
  if (url.origin !== definition.origin || !definition.conversation.test(url.pathname) ||
    url.search || url.hash || url.username || url.password) throw new Error("Conversation URL not on the approved provider");
  return url.origin + url.pathname.replace(/\/$/, "");
}
export function validateAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid action");
  if (typeof value.id !== "string" || !ID.test(value.id)) throw new Error("Invalid action ID");
  if (value.approved !== true) throw new Error("Action not approved");
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 12000) throw new Error("Prompt must be short non-empty text");
  return { id: value.id, provider: value.provider,
    conversation_url: conversationUrl(value.provider, value.conversation_url),
    prompt: value.prompt, approved: true };
}
export function promptDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}
async function safeDirectory(dir) {
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe browser state directory");
    if (process.platform !== "win32" && (st.mode & 0o077)) await fs.chmod(dir, 0o700);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}
export async function prepareLocalState(base = homeDir()) {
  await safeDirectory(base);
  await safeDirectory(path.join(base, "receipts"));
  return { receipts: path.join(base, "receipts") };
}
export function receiptPath(receipts, id) {
  if (!ID.test(id)) throw new Error("Invalid action ID");
  return path.join(receipts, id + ".json");
}
export async function reserve(receipts, action) {
  const file = receiptPath(receipts, action.id);
  const receipt = { version: 1, id: action.id, provider: action.provider,
    conversation_url: action.conversation_url, prompt_sha256: promptDigest(action.prompt),
    status: "reserved", at: new Date().toISOString() };
  // Exclusive create: a process crash / ambiguous send will never silently retry.
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(receipt) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  return receipt;
}
export async function markReceipt(receipts, receipt, status, note) {
  if (!["submitted_unverified", "uncertain", "needs_login", "blocked_permission", "not_submitted", "prepared", "owner_confirmed_sent", "owner_cancelled"].includes(status)) throw new Error("Invalid receipt status");
  const file = receiptPath(receipts, receipt.id);
  const updated = { ...receipt, status, at: new Date().toISOString(), note };
  // Atomic replacement on same filesystem. Never stores prompt/cookies/reply.
  const temporary = file + "." + process.pid + ".tmp";
  const h = await fs.open(temporary, "wx", 0o600);
  try { await h.writeFile(JSON.stringify(updated) + "\n"); await h.sync(); }
  finally { await h.close(); }
  await fs.rename(temporary, file);
  return updated;
}
export async function getReceipt(receipts, id) {
  try { return JSON.parse(await fs.readFile(receiptPath(receipts, id), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
