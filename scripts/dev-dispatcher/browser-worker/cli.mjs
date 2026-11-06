#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { providers, conversationUrl, prepareLocalState } from "./state.mjs";
import { launchFirefox, checkFirefox } from "./firefox.mjs";
import { probe, localSubmissionAllowed } from "./browser.mjs";

async function main(args = process.argv.slice(2)) {
  const [command, arg] = args;
  if (!["doctor", "check", "login", "probe", "send"].includes(command))
    throw new Error("Usage: node cli.mjs doctor | check | login <chatgpt|claude> | probe <conversation-url>");
  if (command === "send") throw new Error("Live sends are disabled in the Firefox worker; do not supply an action file");

  const local = await prepareLocalState();
  if (command === "doctor") {
    console.log("Dedicated Firefox worker state is ready (this does not prove the browser launches).");
    console.log("Private browser profile:", local.profile);
    console.log("Live submissions enabled:", localSubmissionAllowed());
    console.log("Next step: node cli.mjs check");
    return;
  }
  let provider, target;
  if (command === "login") {
    provider = arg;
    if (!providers[provider]) throw new Error("Choose chatgpt or claude");
    target = providers[provider].origin;
  } else if (command === "probe") {
    if (!arg) throw new Error("Provide an existing ChatGPT or Claude conversation URL");
    let origin;
    try { origin = new URL(arg).origin; } catch { throw new Error("Invalid conversation URL"); }
    provider = Object.keys(providers).find(p => providers[p].origin === origin);
    target = conversationUrl(provider, arg);
  }

  let driver;
  try {
    ({ driver } = await launchFirefox(local.profile));
    if (command === "check") {
      await checkFirefox(driver);
      console.log("PASS: Selenium launched your installed Firefox using its separate local profile.");
      console.log("No ChatGPT or Claude pages were opened; no logins or prompts sent.");
      return;
    }
    await driver.get(target);
    if (command === "login") {
      console.log("Sign in MANUALLY in the Firefox window that Selenium opened.");
      console.log("This is a separate profile from your normal Firefox window.");
      const input = createInterface({ input: stdin, output: stdout });
      try { await input.question("When finished, press Enter here to close this worker window: "); }
      finally { input.close(); }
      console.log("Your profile stays on this Mac; logins may still expire.");
      return;
    }
    // SPA editor may take a few moments after navigation; do not inspect chat replies.
    const { css } = await import("selenium-webdriver").then(s => ({ css: (s.default ?? s).By.css }));
    let status = await probe(driver, provider, target, { css });
    if (!status.ready && status.reason === "composer_missing_or_login_required") {
      try {
        await driver.wait(async () => {
          status = await probe(driver, provider, target, { css });
          return status.ready || status.reason !== "composer_missing_or_login_required";
        }, 10000);
      } catch { /* return the last fail-closed status */ }
    }
    console.log(status.ready ? "READY: expected conversation with idle editor" : `NOT READY: ${status.reason}`);
    if (!status.ready) process.exitCode = 2;
  } finally {
    if (driver) await driver.quit();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
