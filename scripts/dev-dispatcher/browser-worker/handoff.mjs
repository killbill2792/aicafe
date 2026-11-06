// macOS handoff to the OWNER'S NORMAL FIREFOX. This module never connects to,
// inspects, or controls a logged-in browser session; there is no DOM automation.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs";
import { reserve, markReceipt, getReceipt, validateAction } from "./state.mjs";

const execFileAsync = promisify(execFile);
const accessAsync = promisify(access);

export async function checkMacCommands(platform = process.platform) {
  if (platform !== "darwin") throw new Error("This handoff currently supports macOS only");
  await Promise.all([
    accessAsync("/usr/bin/open", constants.X_OK),
    accessAsync("/usr/bin/pbcopy", constants.X_OK),
  ]);
  return true; // Does not prove Firefox is installed or authenticated.
}

export function nativeMacBridge() {
  return {
    async openConversation(url) {
      await checkMacCommands();
      // No shell, no --args, no new Firefox instance/profile. Uses the regular OS session.
      await execFileAsync("/usr/bin/open", ["-a", "Firefox", url], { timeout: 15000 });
    },
    async copyPrompt(prompt) {
      await checkMacCommands();
      await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", reject);
        child.stdin.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error("Clipboard copy failed")));
        child.stdin.end(prompt); // Prompt is never an argument, shell command, or log.
      });
    },
  };
}

export async function prepareHandoff(receipts, candidate, bridge = nativeMacBridge()) {
  const action = validateAction(candidate); // validates exact URL and owner-approved flag
  const reservation = await reserve(receipts, action); // Exclusive; duplicate ID stops BEFORE effects.
  try {
    await bridge.openConversation(action.conversation_url);
    await bridge.copyPrompt(action.prompt);
    const prepared = await markReceipt(receipts, reservation, "prepared",
      "Opened regular browser and copied prompt; owner must paste and click Send");
    return { id: prepared.id, provider: prepared.provider, conversation_url: prepared.conversation_url, status: prepared.status };
  } catch {
    // A crash or partial OS effect must not cause an automated replay.
    await markReceipt(receipts, reservation, "uncertain",
      "Browser/clipboard preparation interrupted; inspect before deciding what happened");
    throw new Error("Handoff interrupted. Check your browser and clipboard; never retry the same action ID blindly.");
  }
}

export async function finishHandoff(receipts, id, ownerDecision) {
  if (!["SENT", "CANCEL"].includes(ownerDecision)) throw new Error("Owner must explicitly enter SENT or CANCEL");
  const receipt = await getReceipt(receipts, id); // Also validates ID.
  if (!receipt) throw new Error("No handoff receipt exists for this ID");
  if (!["reserved", "uncertain", "prepared"].includes(receipt.status))
    throw new Error(`Action already finalized as ${receipt.status}`);
  const status = ownerDecision === "SENT" ? "owner_confirmed_sent" : "owner_cancelled";
  // An owner attestation is NOT verification that ChatGPT/Claude received it.
  return markReceipt(receipts, receipt, status,
    ownerDecision === "SENT" ? "Owner reports manually clicking Send; provider delivery not independently verified"
      : "Owner cancelled manual handoff; no message delivery claimed");
}
