import {execFileSync, spawnSync} from "node:child_process";
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {pathToFileURL} from "node:url";

export const SCENARIOS = Object.freeze(["home", "staff", "menu", "money", "gmail", "purchasing"]);
const ALL = SCENARIOS;

// Screens restyled by the glass/rem text-size design change (look only, no behaviour change). The
// global theme files already require every journey; these exact paths run the same full set.
// Other unknown UI still fails closed.
const TAILWIND_RESTYLE = new Set([
  "app/[locale]/staff/page.tsx",
  "app/admin/briefs/page.tsx",
  "app/admin/cafes/[cafeId]/page.tsx",
  "app/admin/codes/[codeId]/page.tsx",
  "app/admin/conversations/[turnId]/page.tsx",
  "app/admin/proactive/page.tsx",
  "components/LoginForm.tsx",
  "components/SideNav.tsx",
  "components/admin/TestBriefButton.tsx",
  "components/crew/CrewInbox.tsx",
  "components/home/BeforeAfterRows.tsx",
  "components/home/CafeNotesList.tsx",
  "components/home/ChatJobProgress.tsx",
  "components/home/ChatMarkdown.tsx",
  "components/home/ChatStart.tsx",
  "components/home/ClarifyCard.tsx",
  "components/home/ComingUpCard.tsx",
  "components/home/EventsVisualFixture.tsx",
  "components/home/FactSummary.tsx",
  "components/home/HowIGotThis.tsx",
  "components/home/MemoryCard.tsx",
  "components/home/SavedEventsCard.tsx",
  "components/home/SupervisorChatComposer.test.tsx",
  "components/home/SupervisorChatComposer.tsx",
  "components/home/SupervisorExperiment.tsx",
  "components/home/SupervisorMandatePanel.tsx",
  "components/home/SupervisorProposalCard.tsx",
  "components/home/SupervisorRichPresentation.tsx",
  "components/home/SupervisorRoutineInlineCard.tsx",
  "components/home/SupervisorWorkStatus.tsx",
  "components/home/responseTableLayout.ts",
  "components/menu/MenuCatalog.tsx",
  "components/menu/PantryWorkspace.tsx",
  "components/menu/ProductPhotoEditor.tsx",
  "components/menu/SizeLabelClarifyDialog.tsx",
  "components/money/MoneyViewSwitch.tsx",
  "components/more/ProcessingFeeEstimateForm.tsx",
  "components/shared/InfoPopover.tsx",
  "components/staff/PosImportReviewPanel.tsx",
  "components/staff/RulesWorkspace.tsx",
  "components/staff/ShiftPreview.tsx",
  "components/staff/StaffCommunicationHistory.tsx",
  "components/staff/StaffReplyComposer.tsx",
  "components/staff/StaffWorkspace.tsx",
]);
const GLASS_RESTYLE = new Set([
  "app/[locale]/menu/import-review/page.tsx",
  "app/[locale]/more/alerts/[id]/page.tsx",
  "app/[locale]/more/alerts/page.tsx",
  "app/[locale]/more/cafe-profile/page.tsx",
  "app/[locale]/more/plan/page.tsx",
  "app/[locale]/more/uploads/page.tsx",
  "app/[locale]/operations/experiments/page.tsx",
  "app/[locale]/privacy/page.tsx",
  "app/admin/cafes/page.tsx",
  "app/admin/conversations/page.tsx",
  "app/textSize.ts",
  "components/SignupForm.tsx",
  "components/access/RedeemCodeForm.tsx",
  "components/admin/CodeConsole.tsx",
  "components/alerts/AlertCard.tsx",
  "components/bills/BillsManager.tsx",
  "components/menu/AggregateProductCostEditor.tsx",
  "components/menu/AllSizesRecipe.tsx",
  "components/menu/InlinePantryTable.tsx",
  "components/menu/InventoryModifierPanel.tsx",
  "components/menu/InventoryPurchasePanel.tsx",
  "components/menu/MenuAddonsPanel.tsx",
  "components/menu/MenuComboBuilder.tsx",
  "components/menu/MenuPricePreview.tsx",
  "components/menu/MilkSizePrices.tsx",
  "components/menu/NewMenuItemForm.tsx",
  "components/menu/NewPantryInlineRow.tsx",
  "components/menu/ProductDetailScreen.tsx",
  "components/money/CostRecoveryView.tsx",
  "components/money/MonthCalendar.tsx",
  "components/money/ProfitCostsView.labor.test.tsx",
  "components/money/ProfitCostsView.tsx",
  "components/more/CafeProfileForm.tsx",
  "components/more/FinancialSettingsForm.tsx",
  "components/more/ProfitGoalSimulator.tsx",
  "components/more/ToastConnectionForm.tsx",
  "components/more/ToastOnboardingChecklist.tsx",
  "components/more/ToastOwnerDashboard.tsx",
  "components/more/ToastSummaryComparison.tsx",
  "components/operations/AITeamCard.tsx",
  "components/operations/ExperimentReportActions.tsx",
  "components/operations/OwnerWhatsAppAlerts.tsx",
  "components/operations/TeamInbox.tsx",
  "components/operations/TeamRulesManager.tsx",
  "components/scenario/TryScenario.tsx",
  "components/shared/EstimatePill.tsx",
  "components/shared/LanguageSwitch.tsx",
  "components/shared/PeriodSwitch.tsx",
  "components/shared/TodayAtAGlanceCard.tsx",
  "components/staff/DayTimeline.tsx",
  "components/staff/OwnerScheduleSendPanel.tsx",
  "components/staff/PayrollCostCard.tsx",
  "components/staff/StaffDraftApprovalCard.tsx",
  "components/staff/WeekGrid.tsx",
  "components/ui/ThemePicker.tsx",
  "components/uploads/LaborCsvImporter.tsx",
  "components/uploads/ProcessingFeeImporter.tsx",
  "components/uploads/SalesCsvImporter.tsx",
]);

// Recognize real user journeys, not just *.spec.* changes. Unknown browser UI
// must fail closed instead of permitting an untested screen to merge.
export function scenariosForPath(path) {
  if (path === ".github/workflows/ai-cafe-pr-baseline.yml" ||
      path === "playwright.config.mjs" || path.startsWith("scripts/e2e/") ||
      path.startsWith("tests/e2e/") ||
      path === "app/globals.css" || path === "tailwind.config.ts" || path === "postcss.config.mjs" || path.startsWith("app/fonts/") ||
      path.startsWith("app/themes") || path.startsWith("public/") ||
      path === "proxy.ts" ||
      path === "app/[locale]/layout.tsx" ||
      path === "app/[locale]/loading.tsx" ||
      path.startsWith("app/[locale]/login/") ||
      path === "components/LoginForm.tsx" ||
      path === "components/TabBar.tsx" ||
      path === "components/SideNav.tsx" ||
      path === "components/shared/PageShell.tsx" ||
      path === "components/shared/BackHeader.tsx" ||
      path.startsWith("lib/auth/") ||
      path.startsWith("lib/supabase/") ||
      path === "messages/en.json" || GLASS_RESTYLE.has(path)) return ALL;
  // Keep the existing Glass ALL classification for ToastConnectionForm.
  if (path === "components/more/ToastWebhookSetup.tsx" ||
      path === "app/[locale]/more/toast/page.tsx") return ["home"];
  // The owner More page contains Gmail controls and is a restricted owner
  // navigation destination for workers. Require BOTH real browser journeys.
  if (path === "app/[locale]/more/page.tsx") return ["staff","gmail"];
  if (path === "app/admin/costs/page.tsx" ||
      path === "app/[locale]/more/gmail/page.tsx" ||
      path === "app/[locale]/more/supervisor-access/page.tsx" ||
      path === "components/more/SupervisorAccessPanel.tsx" ||
      path === "components/more/GmailConnectionPanel.tsx" ||
      path === "components/home/SupervisorProposalCard.tsx" ||
      path === "components/home/SupervisorProposalCard.gmail.test.tsx" ||
      path === "components/more/GmailConnectionPanel.test.tsx")
    return path === "components/home/SupervisorProposalCard.tsx" ? ["gmail","purchasing"] : ["gmail"];
  // Task15A's owner-facing Operations report must run through a REAL signed-in
  // seeded browser, not merely a server-component/unit render. The @home
  // owner-inbox journey verifies the persisted report and its original thread.
  if(path==="app/[locale]/operations/page.tsx"||
     path==="app/[locale]/operations/page.test.tsx")
    return ["home"];
  // Maintenance intake and verification must run the signed-in, locally
  // seeded owner Operations journey. Never classify new owner UI as backend.
  if (path === "components/operations/MaintenanceCaseCard.tsx" ||
      path === "components/operations/MaintenanceCaseCard.test.tsx")
    return ["home"];
  if (path === "components/operations/OwnerPushReports.tsx" ||
      path === "components/operations/AcknowledgeFailedWork.tsx" ||
      path === "components/more/SignOutButton.tsx") return ["home"];
  if (path === "components/operations/SupplierEvidenceManager.tsx" ||
      path === "components/operations/SupplierVendorCommunicationManager.tsx" ||
      path === "app/[locale]/operations/suppliers/page.tsx")
    return ["purchasing"];
  if (path === "components/alerts/alertContent.ts" || path === "components/alerts/alertContent.test.ts") return ["home"];
  if (path.startsWith("components/home/")) return ["home"];
  if (path === "app/[locale]/page.tsx" ||
      path.startsWith("lib/viewmodels/home") ||
      path === "scripts/ldi-g-visual-check.mjs" ||
      path === ".github/workflows/ldi-g-events-visual.yml")
    return ["home"];
  // Worker-only pages are covered by the real seeded employee-login and
  // owner-receipt @staff browser journey; unknown UI still fails closed.
  if (path.startsWith("app/crew/") || path.startsWith("components/crew/") ||
      path === "components/staff/StaffLoginLinkPanel.tsx" ||
      path === "components/staff/StaffResponseInbox.tsx" ||
      path === "components/staff/StaffCommunicationHistory.tsx" ||
      path === "components/staff/StaffReplyComposer.tsx" ||
      path === "components/staff/StaffCoordinationPanel.tsx") return ["staff"];
  // Toast-first registration renders this component; the seeded @staff
  // browser journey includes the new-owner onboarding and worker denial.
  if (path === "app/[locale]/onboarding/page.tsx" ||
      path === "components/onboarding/RegisterChoice.tsx" ||
      path === "components/onboarding/RegisterChoice.test.ts") return ["staff"];
  // The bills contract test covers owner bill editing after Toast-first setup.
  if(path==="components/addcost/redesign03Flows.test.ts")return ["money"];
  if (path === "app/[locale]/pricing/page.tsx") return ["staff"];
  if (path === "app/[locale]/staff/page.tsx" ||
      path === "components/staff/StaffWorkspace.tsx" ||
      path === "components/staff/StaffPublicationStatus.tsx" ||
      path === "components/staff/StaffStandingMandatePanel.tsx" ||
      path === "components/staff/StaffStandingMandatePanel.test.ts" ||
      path.startsWith("lib/calc/scheduling/") ||
      path === "scripts/staff-pr155-screenshots.mjs" ||
      path === ".github/workflows/staff-pr155-screenshots.yml")
    return ["staff"];
  if (path === "app/[locale]/menu/page.tsx" ||
      path === "app/[locale]/menu/pantry/page.tsx" ||
      path === "components/menu/PantryWorkspace.tsx" ||
      path === "components/menu/MenuCatalog.tsx" ||
      path.startsWith("lib/viewmodels/menu")) return ["menu"];
  if (path === "components/addcost/StatementUploader.tsx" || path === "app/[locale]/money/page.tsx" ||
      path === "components/money/MoneyViewSwitch.tsx" ||
      path.startsWith("lib/viewmodels/money")) return ["money"];
  if (path.startsWith("app/api/")) return [];
  // Preserve specific journey mappings above; cover remaining migrated UI paths.
  if (TAILWIND_RESTYLE.has(path)) return ALL;
  if (/^app\/\[locale\]\//.test(path) ||
      path.startsWith("components/") ||
      (path.startsWith("app/") && !path.endsWith(".test.ts") &&
        !path.endsWith(".test.tsx"))) return null;
  return [];
}

export function classifyPaths(paths) {
  const selected = new Set(), unmapped = [];
  for (const path of paths) {
    const scenarios = scenariosForPath(path);
    if (scenarios === null) unmapped.push(path);
    else for (const scenario of scenarios) selected.add(scenario);
  }
  return {
    scenarios: SCENARIOS.filter(scenario => selected.has(scenario)),
    unmapped: [...new Set(unmapped)].sort(),
    required: selected.size > 0 || unmapped.length > 0,
  };
}

// -z output is NUL-delimited, with two filenames for R/C statuses. Both
// source and destination need classification, including moves out of a UI path.
export function parseNameStatus(raw) {
  const tokens = Buffer.isBuffer(raw) ? raw.toString("utf8").split("\0") : raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status))
      throw new Error("Unrecognized git diff status");
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (i + count > tokens.length) throw new Error("Truncated git diff status");
    for (let j = 0; j < count; j++) {
      const path = tokens[i++];
      if (!path) throw new Error("Empty changed path");
      paths.push(path);
    }
  }
  return paths;
}

export function selectedScenarios(value) {
  const items = value.split(",").filter(Boolean);
  if (!items.length || new Set(items).size !== items.length ||
      items.some(item => !SCENARIOS.includes(item)))
    throw new Error("Missing or invalid selected browser scenarios");
  return SCENARIOS.filter(item => items.includes(item));
}

function allSpecs(suites, out = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) out.push(spec);
    allSpecs(suite.suites, out);
  }
  return out;
}

export function summarizeReport(report, scenarios) {
  if (!report || !Array.isArray(report.suites)) throw new Error("Missing Playwright suites");
  const counts = Object.fromEntries(scenarios.map(id =>
    [id, {scenario_id: id, passed: 0, failed: 0, skipped: 0}]));
  let unexpected = 0;
  for (const spec of allSpecs(report.suites)) {
    const ids = scenarios.filter(id => new RegExp("(?:^|\\s)@" + id + "(?:\\s|$)").test(spec.title ?? ""));
    for (const test of spec.tests ?? []) {
      const last = test.results?.at(-1);
      const passed = test.status === "expected" && last?.status === "passed";
      const skipped = test.status === "skipped" || last?.status === "skipped";
      if (!ids.length) { unexpected++; continue; }
      for (const id of ids) {
        const count = counts[id];
        count[passed ? "passed" : skipped ? "skipped" : "failed"]++;
      }
    }
  }
  const selected = Object.values(counts);
  const valid = unexpected === 0 && selected.every(c => c.passed > 0 && c.failed === 0 && c.skipped === 0) &&
    Number(report.stats?.unexpected ?? 0) === 0 &&
    Number(report.stats?.skipped ?? 0) === 0;
  return {
    status: valid ? "passed" : "failed",
    scenarios: selected,
    executed_count: selected.reduce((n, c) => n + c.passed + c.failed, 0),
    rejected_unmapped_tests: unexpected,
  };
}

function appendOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
}
function git(...args) { return execFileSync("git", args, {encoding: "utf8"}).trim(); }
function choose() {
  const {BASE_SHA, HEAD_SHA} = process.env;
  if (![BASE_SHA, HEAD_SHA].every(s => /^[a-f0-9]{40}$/.test(s ?? "")))
    throw new Error("A real GitHub base/head SHA pair is required");
  const mergeBase = git("merge-base", BASE_SHA, HEAD_SHA);
  const raw = execFileSync("git", ["diff", "--name-status", "-z", "-M", mergeBase, HEAD_SHA, "--"]);
  const decision = classifyPaths(parseNameStatus(raw));
  if (decision.unmapped.length)
    throw new Error("UI/browser paths have no targeted Playwright scenario: " +
      decision.unmapped.join(", "));
  appendOutput("browser_required", String(decision.required));
  appendOutput("browser_scenarios", decision.scenarios.join(","));
  appendOutput("browser_reason", decision.required ? "targeted UI/browser change" : "backend/docs only");
  console.log(decision.required
    ? "Required browser scenarios: " + decision.scenarios.join(", ")
    : "Browser N/A: backend/docs-only diff");
}
function run() {
  const selected = selectedScenarios(process.env.BROWSER_SCENARIOS ?? "");
  const grep = "(?:^|\\s)@(?:" + selected.join("|") + ")(?:\\s|$)";
  const result = spawnSync(process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--grep", grep],
    {stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
function verify() {
  const selected = selectedScenarios(process.env.BROWSER_SCENARIOS ?? "");
  const output = "test-results/e2e/proof.json";
  const result = "test-results/e2e/results.json";
  const head = process.env.HEAD_SHA;
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("Missing exact head SHA");
  const report = JSON.parse(readFileSync(result, "utf8"));
  const proof = summarizeReport(report, selected);
  const receipt = {
    schema_version: 1,
    head_sha: head,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    job: process.env.GITHUB_JOB ?? null,
    artifact_name: "aicafe-e2-targeted-browser-proof",
    ...proof,
  };
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log("E2 browser proof:", JSON.stringify(receipt));
  if (proof.status !== "passed") throw new Error("Required Playwright proof failed or skipped");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (command === "select") choose();
    else if (command === "run") run();
    else if (command === "verify") verify();
    else throw new Error("Usage: targeted.mjs select|run|verify");
  } catch (error) {
    console.error("E2:", error.message);
    process.exitCode = 1;
  }
}
