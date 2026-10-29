import {describe,it,expect} from "vitest";
import {existsSync,readdirSync,readFileSync} from "node:fs";
import {join,relative,sep} from "node:path";
const moneyNames=/(cardFee|processingFee|laborCost|laborPercent|staffCost|ownerProfit|profitFor|breakEven|moneyLeft)/i;

/** Each permitted legacy facade is explicitly scheduled for canonical redirect in PR 2. */
const pr2Duplicates:Readonly<Record<string,string>>={
 "lib/calc/profit.ts::cardFeesCentsForPeriod":"REDIRECT in PR 2: period card fee to core/fees",
 "lib/calc/profit.ts::staffCostCentsForPeriod":"REDIRECT in PR 2: period labor to core/labor",
 "lib/calc/profit.ts::laborKnown":"REDIRECT in PR 2: labor completeness to core/labor",
 "lib/calc/profit.ts::totalCostsCentsForPeriod":"REDIRECT in PR 2: full profit to core/profit",
 "lib/calc/staff.ts::staffCostCentsForTimecard":"REDIRECT in PR 2: loaded wages to core/labor",
 "lib/calc/supervisorEconomics.ts::fixedCardFeeForCoveredSales":"REDIRECT in PR 2: fixed per-payment fee to core/fees",
 "lib/calc/planGoals.ts::simulatePlanChange":"REDIRECT in PR 2: scenario calculations to shared economics",
 "lib/calc/pricingEngine.ts::suggestPrice":"REDIRECT in PR 2: price economics to core",
 "lib/calc/ownerReportedBreakEven.ts::ownerReportedBreakEven":"REDIRECT in PR 2: include the fixed 15c payment fee"
};
const fileAllow:Readonly<Record<string,string>>={
 "lib/calc/breakEvenSales.ts":"Core breakEven uses this shared solver",
 "lib/calc/toastPaymentFee.ts":"D-owned per-payment Toast fee source; do not edit in PR 1"
};
function productionFiles(){
 const root=process.cwd(),paths:string[]=[];
 const walk=(dir:string)=>{if(!existsSync(dir))return;
  for(const d of readdirSync(dir,{withFileTypes:true})){
   const full=join(dir,d.name);
   if(d.isDirectory()){if(!["node_modules",".next"].includes(d.name))walk(full);continue;}
   if(!d.isFile()||!/\.(?:ts|tsx|js|mjs)$/.test(d.name)||/\.(?:test|spec)\./.test(d.name))continue;
   paths.push(full);
  }
 };
 walk(join(root,"lib"));
 return paths.map(p=>({path:relative(root,p).split(sep).join("/"),text:readFileSync(p,"utf8")}));
}
describe("canonical money and labor exports only",()=>{
 it("does not introduce a second export for shared money math",()=>{
  const violations:string[]=[];
  for(const file of productionFiles()){
   if(file.path.startsWith("lib/metrics/core/")||fileAllow[file.path])continue;
   for(const match of file.text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)){
    const name=match[1];if(!moneyNames.test(name))continue;
    const key=`${file.path}::${name}`;
    if(!pr2Duplicates[key])violations.push(key);
   }
  }
  expect(violations).toEqual([]);
 });
 it("documents a reason and redirect for every legacy exception",()=>{
  expect(Object.values(pr2Duplicates).every(v=>v.startsWith("REDIRECT in PR 2:"))).toBe(true);
  expect(Object.values(fileAllow).every(Boolean)).toBe(true);
 });
});
