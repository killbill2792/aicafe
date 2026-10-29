import {describe,expect,it} from "vitest";
import {readdirSync,readFileSync,statSync} from "node:fs";
import path from "node:path";

/** AGENTS.md rule 3: one reader per fact. Saved daily totals are read through
 * lib/data/dailyFacts.server.ts. Other files may only WRITE daily_rollups, or
 * read a narrow non-money field listed here with its reason. */
const ALLOWED:Record<string,string>={
 "lib/data/dailyFacts.server.ts":"the shared reader",
 "lib/pos/rollup.ts":"writer",
 "lib/pos/toast/dayImport.ts":"writer (Toast import)",
 "lib/pos/toast/promote.ts":"writer (Toast promotion)",
 "lib/pos/toast/rollupRetries.ts":"writer retry status",
 "lib/pos/processingFeeEstimate.server.ts":"writer (fee estimates)",
 "lib/actions/payrollCosts.ts":"writer (payroll cost update)",
 "lib/actions/processingFeeEstimate.ts":"fee setup: which days lack a fee",
 "lib/data/getProcessingFeeEstimateSetup.ts":"fee setup: which days lack a fee",
 "lib/data/getPayrollCostSettings.ts":"payroll tax source label",
 "lib/data/menuPriceEvidence.server.ts":"latest covered date only",
 "lib/data/getMoreBadges.ts":"badge: days with sales",
 "lib/data/getAlerts.ts":"void alert status",
 "lib/alerts/generate.ts":"void alert status",
};
function files(dir:string):string[]{
 return readdirSync(dir).flatMap(name=>{
  const full=path.join(dir,name);
  if(statSync(full).isDirectory())return name==="node_modules"||name.startsWith(".")?[]:files(full);
  return /\.(ts|tsx)$/.test(name)&&!/\.test\.tsx?$/.test(name)?[full]:[];
 });
}
describe("one path for daily totals",()=>{
 it("no screen or chat code reads daily_rollups except through the shared reader",()=>{
  const root=process.cwd();
  const offenders=[...files(path.join(root,"lib")),...files(path.join(root,"app")),...files(path.join(root,"components"))]
   .map(f=>path.relative(root,f).split(path.sep).join("/"))
   .filter(f=>!ALLOWED[f]&&/from\(\s*"daily_rollups"\s*\)/.test(readFileSync(f,"utf8")));
  expect(offenders).toEqual([]);
 });
});
