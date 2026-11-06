#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { providers, conversationUrl, validateAction, prepareLocalState, reserve, markReceipt, getReceipt } from "./state.mjs";
import { probe, submit, localSubmissionAllowed } from "./browser.mjs";

async function launch(profile) {
  // Only the separately installed worker's Playwright is imported, never app test tooling.
  let playwright;
  try { playwright = await import("playwright"); }
  catch { throw new Error("Install local worker dependencies first (see browser-worker/README.md)"); }
  return playwright.chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1280, height: 850 },
    acceptDownloads: false, serviceWorkers: "block",
  });
}
async function openConversation(context, provider, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Never continue after cross-origin redirect. No reading message contents.
  conversationUrl(provider, page.url());
  return page;
}
async function main(args = process.argv.slice(2)) {
  const [command, arg] = args;
  if (command === "doctor") {
    const state = await prepareLocalState();
    console.log("Local worker ready: separate profile and receipts exist outside the repository.");
    console.log("Browser profile path:", state.profile);
    console.log("Live submissions enabled:", localSubmissionAllowed());
    return;
  }
  if (!["login", "probe", "send"].includes(command)) throw new Error("Usage: node cli.mjs doctor | login <chatgpt|claude> | probe <conversation-url> | send <private-action.json>");
  const state = await prepareLocalState();
  let action, provider, target;
  if (command === "login") {
    provider = arg;
    if (!providers[provider]) throw new Error("Unknown provider");
    target = providers[provider].origin;
  } else if (command === "probe") {
    const url = new URL(arg);
    provider = Object.keys(providers).find(p => providers[p].origin === url.origin);
    target = conversationUrl(provider, arg);
  } else {
    if (!arg) throw new Error("Missing local action file");
    action = validateAction(JSON.parse(await readFile(arg, "utf8")));
    provider = action.provider;
    target = action.conversation_url;
    if (!localSubmissionAllowed()) throw new Error("Submission disabled; site permission and explicit local approval required");
    const existing = await getReceipt(state.receipts, action.id);
    if (existing) throw new Error(`Action ${action.id} already has receipt ${existing.status}; never retry blindly`);
  }
  const context = await launch(state.profile);
  try {
    if (command === "login") {
      const page = await context.newPage();
      await page.goto(target, { waitUntil: "domcontentloaded" });
      console.log("Sign in manually in the isolated browser. Never paste passwords into chat or GitHub.");
      const input = createInterface({ input: stdin, output: stdout });
      try { await input.question("Press Enter here after you finish logging in and close any popups: "); }
      finally { input.close(); }
      console.log("Browser profile remains only on this computer.");
      return;
    }
    const page = await openConversation(context, provider, target);
    if (command === "probe") {
      const state = await probe(page, provider, target);
      console.log(state.ready ? "READY: exact conversation and idle composer" : `NOT READY: ${state.reason}`);
      if (!state.ready) process.exitCode = 2;
      return;
    }
    // Reserve before interacting; if process dies, never repeat without manual inspection.
    const receipt = await reserve(state.receipts, action);
    try {
      const result = await submit(page, action, { canSubmit: true });
      await markReceipt(state.receipts, receipt, result.status, result.reason || "Click attempted; actual delivery not established");
      console.log(`Action ${action.id}: ${result.status}. See local receipt; no assistant responses read.`);
    } catch {
      await markReceipt(state.receipts, receipt, "uncertain", "Browser interaction failed; inspect conversation before deciding to retry");
      throw new Error("Send uncertain; do not repeat automatically. Check the conversation manually.");
    }
  } finally { await context.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
