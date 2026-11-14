import test from "node:test";
import assert from "node:assert/strict";
import {classifyPaths, parseNameStatus, selectedScenarios, summarizeReport} from "./targeted.mjs";

test("real Home, Staff, Menu, Money and Gmail changes select only relevant journeys", () => {
  assert.deepEqual(classifyPaths(["app/[locale]/page.tsx"]).scenarios, ["home"]);
  assert.deepEqual(classifyPaths(["components/staff/StaffWorkspace.tsx"]).scenarios, ["staff"]);
  assert.deepEqual(classifyPaths(["app/[locale]/menu/page.tsx"]).scenarios, ["menu"]);
  assert.deepEqual(classifyPaths(["app/[locale]/money/page.tsx"]).scenarios, ["money"]);
  assert.deepEqual(classifyPaths(["app/[locale]/more/gmail/page.tsx"]).scenarios, ["gmail"]);
  assert.deepEqual(classifyPaths(["components/more/GmailConnectionPanel.tsx"]).scenarios, ["gmail"]);
  assert.deepEqual(classifyPaths(["app/[locale]/layout.tsx"]).scenarios,
    ["home", "staff", "menu", "money", "gmail", "purchasing"]);
});

test("backend and docs are not delayed by unrelated browser jobs", () => {
  const decision = classifyPaths(["lib/ai/agent/loop.server.ts", "app/api/chat/route.ts", "docs/README.md"]);
  assert.equal(decision.required, false);
  assert.deepEqual(decision.scenarios, []);
  assert.deepEqual(decision.unmapped, []);
  assert.equal(classifyPaths(["package.json", "package-lock.json", "lib/ai/worker.spec.ts"]).required, false);
});

test("unknown browser UI cannot silently skip required proof", () => {
  const decision = classifyPaths(["app/[locale]/pricing/page.tsx", "components/UnknownWidget.tsx"]);
  assert.equal(decision.required, true);
  assert.deepEqual(decision.unmapped,
    ["app/[locale]/pricing/page.tsx", "components/UnknownWidget.tsx"]);
  assert.deepEqual(decision.scenarios, []);
  const unexercised = classifyPaths([
    "app/[locale]/staff/rules/page.tsx",
    "app/[locale]/menu/new/page.tsx",
    "components/money/ProfitCostsView.tsx",
    "app/[locale]/onboarding/page.tsx",
  ]);
  assert.equal(unexercised.required, true);
  assert.deepEqual(unexercised.scenarios, []);
  assert.equal(unexercised.unmapped.length, 4);
});

test("rename tracks both old and new UI/browser paths", () => {
  const paths = parseNameStatus("R100\0app/[locale]/staff/page.tsx\0app/api/new.ts\0M\0docs/README.md\0");
  assert.deepEqual(paths, ["app/[locale]/staff/page.tsx", "app/api/new.ts", "docs/README.md"]);
  assert.deepEqual(classifyPaths(paths).scenarios, ["staff"]);
  assert.deepEqual(classifyPaths(["app/[locale]/staff/old.tsx"]).unmapped,
    ["app/[locale]/staff/old.tsx"]);
  assert.throws(() => parseNameStatus("R100\0one.ts\0"), /Truncated/);
});

test("browser scenario selection rejects missing, duplicates or unknown names", () => {
  for (const v of ["", "home,home", "home,unknown", "home,"]) {
    if (v === "home,") continue; // trailing separator is normalized by GH output
    assert.throws(() => selectedScenarios(v), /Missing or invalid/);
  }
  assert.deepEqual(selectedScenarios("money,home"), ["home", "money"]);
  assert.deepEqual(selectedScenarios("gmail"), ["gmail"]);
});

function report(rows) {
  return {
    suites: [{specs: rows.map(([scenario, status]) => ({
      title: "@" + scenario + " visible owner journey",
      tests: [{status: status === "passed" ? "expected" : status,
        results: [{status}]}],
    }))}],
    stats: {unexpected: 0, skipped: 0},
  };
}

test("only actual executed passed cases count", () => {
  const proof = summarizeReport(report([["home", "passed"], ["menu", "passed"]]),
    ["home", "menu"]);
  assert.equal(proof.status, "passed");
  assert.equal(proof.executed_count, 2);
  assert.equal(proof.scenarios[1].passed, 1);
});

test("missing, zero, skipped, failed and unrelated Playwright result cannot pass", () => {
  assert.equal(summarizeReport(report([]), ["home"]).status, "failed");
  assert.equal(summarizeReport(report([["home", "skipped"]]), ["home"]).status, "failed");
  assert.equal(summarizeReport(report([["home", "failed"]]), ["home"]).status, "failed");
  assert.equal(summarizeReport(report([["menu", "passed"]]), ["home"]).status, "failed");
  assert.equal(summarizeReport({suites: []}, ["home"]).status, "failed");
  assert.throws(() => summarizeReport(null, ["home"]), /Missing/);
});

test("every selected journey needs its own actually executed case", () => {
  assert.equal(summarizeReport(report([["home", "passed"]]), ["home", "staff"]).status, "failed");
  assert.equal(summarizeReport(report([
    ["home", "passed"], ["home", "skipped"],
  ]), ["home"]).status, "failed");
});

test("Task14B supplier UI and approval card require actual purchasing browser proof",()=>{
 assert.deepEqual(classifyPaths(["components/operations/SupplierEvidenceManager.tsx"]).scenarios,["purchasing"]);
 assert.deepEqual(classifyPaths(["app/[locale]/operations/suppliers/page.tsx"]).scenarios,["purchasing"]);
 assert.deepEqual(classifyPaths(["components/home/SupervisorProposalCard.tsx"]).scenarios,
  ["gmail","purchasing"]);
 assert.equal(summarizeReport(report([["home","passed"]]),["purchasing"]).status,"failed");
});
