import {test} from "node:test";
import assert from "node:assert/strict";
import {classifyPrPaths,changedPrPaths} from "./classify-pr-changes.mjs";
import {parseNameStatus,classifyPaths} from "../e2e/targeted.mjs";

test("classification fails closed on an empty PR or invalid commit",()=>{
 assert.throws(()=>classifyPrPaths([]),/empty PR diff/);
 assert.throws(()=>changedPrPaths("not-a-sha","bad"),/SHAs required/);
});
test("documentation-only changes never skip required guards but do skip costly code suite",()=>{
 assert.deepEqual(classifyPrPaths(["docs/plan.md","README.md"]),{
  code:"false",e2e:"false",supervisor:"false","docs-only":"true","non-docs":"false"});
});
test("Supervisor and attachment UI trigger full code and eval; browser selected separately",()=>{
 assert.deepEqual(classifyPrPaths(["docs/rules.md","lib/ai/conversations/agentRunner.server.ts",
  "components/home/SupervisorChatComposer.tsx"]),{
  code:"true",e2e:"false",supervisor:"true","docs-only":"true","non-docs":"true"});
});
test("renames inspect original and destination; all e2e patterns remain covered",()=>{
 const paths=parseNameStatus(Buffer.from("R100\0tests/e2e/old.spec.mjs\0docs/old.spec.mjs\0"));
 assert.deepEqual(paths,["tests/e2e/old.spec.mjs","docs/old.spec.mjs"]);
 assert.equal(classifyPrPaths(paths).e2e,"true");
 assert.equal(classifyPrPaths(["playwright.config.mjs"]).e2e,"true");
 // The legacy e2e path flag excludes scripts/e2e, but the targeted-browser
 // selector deliberately treats any harness change as all browser scenarios.
 assert.equal(classifyPrPaths(["scripts/e2e/targeted.mjs"]).e2e,"false");
 assert.equal(classifyPaths(["scripts/e2e/targeted.mjs"]).required,true);
 assert.equal(classifyPrPaths(["components/home/Card.spec.tsx"]).e2e,"true");
 assert.equal(classifyPrPaths([".github/workflows/ldi-g-events-visual.yml"]).e2e,"true");
});
