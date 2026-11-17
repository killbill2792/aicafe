import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
/** Regression for Codex P1: never restore paid secret to untrusted candidate. */
const workflow=readFileSync(".github/workflows/ai-cafe-13c-owner-live.yml","utf8");
function step(name:string,next:string){
 const a=workflow.indexOf("      - name: "+name);
 const b=workflow.indexOf("      - name: "+next,a+1);
 expect(a).toBeGreaterThan(0);
 expect(b).toBeGreaterThan(a);
 return workflow.slice(a,b);
}
describe("13C paid Luna trusted-main broker boundaries",()=>{
 it("requires owner exact-head grant, atomically consumed before spending",()=>{
  for(const guard of ["pull_request_target:","github.actor == 'killbill2792'",
   "github.triggering_actor == 'killbill2792'","github.run_attempt == 1",
   "github.event.pull_request.number == 501",
   "github.event.pull_request.base.ref == 'main'",
   "github.event.changes.body.from != null",
   "aicafe-task13c-trusted-paid-run-v1",
   "aicafe-task13c-authorization-consumed:pr501:pilot-v1",
   "if(comments.some(c=>String(c.body||\"\").includes(consumed)))",
   "needs: [consume-once]","cancel-in-progress: false"])expect(workflow).toContain(guard);
 });
 it("never gives the real key or GitHub write token to candidate Docker",()=>{
  const host=step("Start trusted host broker ONLY (real key never passed to candidate)",
   "Run the real registered Supervisor inside unprivileged candidate Docker");
  const candidate=step("Run the real registered Supervisor inside unprivileged candidate Docker",
   "Redacted host broker failure diagnostics");
  const secret="OPENAI_API_KEY: "+"$"+"{{ secrets.OPENAI_API_KEYS }}";
  expect(workflow.split(secret)).toHaveLength(2);
  expect(host).toContain(secret);
  expect(host).toContain("node coordinator/scripts/acceptance/task14b-broker.mjs");
  expect(candidate).not.toContain("secrets.OPENAI_API_KEYS");
  expect(candidate).not.toContain("GITHUB_TOKEN");
  expect(candidate).toContain("OPENAI_API_KEY='sk-local_disposable_proxy_key_not_real'");
  expect(candidate).toContain("task14b-fetch-shim.cjs:ro");
  expect(candidate).toContain("--cap-drop ALL");
  expect(candidate).toContain("--security-opt no-new-privileges");
  // Existing registered Supervisor emits store:false only under its exact
  // local trusted-broker switch, not merely from a dummy API key.
  expect(candidate).toContain("-e AI_CAFE_LIVE_ACCEPTANCE -e APP_URL");
  expect(candidate).toContain("AICAFE_13C_HOST_ATTEST_DB='1'");
  expect(candidate).toContain("cp test-results/acceptance/13c-live-scope.json /proof/13c-live-scope.json");
  expect(candidate).toContain("AICAFE_14B_BROKER_TOKEN=");
  expect(candidate).not.toContain("OPENAI_API_KEYS");
  expect(candidate).not.toContain("AICAFE_TASK14B_HOST_AUDIT");
  expect(workflow).toContain("path: coordinator");
  expect(workflow).toContain("path: candidate");
 });
 it("checks paid host receipts and real source evidence after migrated database",()=>{
  for(const guard of ["node --test scripts/acceptance/task14b-broker.test.mjs",
   "supabase db reset --local --yes",
   "command -v psql >/dev/null",
   "test \"$(git rev-parse HEAD)\" = \"$HEAD_SHA\"",
   "npx vitest run lib/ai/supervisor/routines/staffCoverage.live.test.ts",
   "task13c-host-audit.json","audit.reservedMicros>180_000","audit.attempts>18",
   "staffing=tools.includes(\"get_staff_messages\")",
   "proof.negative_no_automatic_roster_effect!==true",
   "proof.cross_cafe_owner_denied!==true",
   "proof.persisted_followup!==true",
   "audit.receipts.some(r=>r.terminal!==\"completed\"||r.model!==\"gpt-6-luna\")",
   "task13c-sanitized-result.json",
   "13c-live-scope.json","const raw=execFileSync(\"psql\"",
   "facts.currentAssignee!==scope.replacementEmployeeId",
   "facts.investigationPhase!==\"resolved\"",
   "Number(facts.completedQuota)!==audit.attempts"])expect(workflow).toContain(guard);
 });
});
