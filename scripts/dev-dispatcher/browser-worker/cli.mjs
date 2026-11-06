#!/usr/bin/env node
// Assisted delivery only. No automated browser sessions or message sending.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prepareLocalState, getReceipt } from "./state.mjs";
import { checkMacCommands, prepareHandoff, finishHandoff } from "./handoff.mjs";

async function main(args = process.argv.slice(2)) {
  const [command, arg] = args;
  if (["send", "login", "probe"].includes(command))
    throw new Error("Automated login/probe/send is retired. Use handoff with your normal logged-in Firefox.");
  if (!["doctor", "check", "handoff", "status", "confirm", "cancel"].includes(command))
    throw new Error("Usage: node cli.mjs doctor | check | handoff <private-action.json> | status <id> | confirm <id> | cancel <id>");

  const local = await prepareLocalState();
  if (command === "doctor") {
    console.log("Manual Firefox handoff only. No Selenium, browser profile or automatic sends.");
    console.log("Private receipts:", local.receipts);
    console.log("Use npm run check to check macOS handoff commands.");
    return;
  }
  if (command === "check") {
    await checkMacCommands();
    console.log("PASS: macOS open/pbcopy commands available.");
    console.log("This does not inspect Firefox or verify any login. No page opened or prompt copied.");
    return;
  }
  if (!arg) throw new Error("A private action JSON file or receipt ID is required");
  if (command === "handoff") {
    const candidate = JSON.parse(await readFile(arg, "utf8"));
    const result = await prepareHandoff(local.receipts, candidate);
    console.log(`PREPARED ${result.id}: opened ${result.conversation_url} in your normal Firefox.`);
    console.log("Prompt copied to the macOS clipboard. Review the exact chat, paste with Command-V, then CLICK SEND yourself.");
    console.log(`After sending, run: node cli.mjs confirm ${result.id}`);
    console.log("If not sent, run: node cli.mjs cancel " + result.id);
    console.log("Clipboard can be read by other local apps; replace/clear it after using the prompt.");
    return;
  }
  if (command === "status") {
    const receipt = await getReceipt(local.receipts, arg);
    if (!receipt) throw new Error("Unknown action ID");
    console.log(JSON.stringify({
      id: receipt.id, provider: receipt.provider, conversation_url: receipt.conversation_url,
      status: receipt.status, at: receipt.at, note: receipt.note || null,
    }, null, 2));
    return;
  }
  const input = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = await input.question(command === "confirm"
      ? "Type SENT only if YOU pasted the prompt and clicked Send in the correct chat: "
      : "Type CANCEL to cancel this unsent handoff: ");
  } finally { input.close(); }
  const receipt = await finishHandoff(local.receipts, arg, answer.trim());
  console.log(`${receipt.id}: ${receipt.status}`);
  if (receipt.status === "owner_confirmed_sent")
    console.log("This records your confirmation only; remote delivery was not independently verified.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
