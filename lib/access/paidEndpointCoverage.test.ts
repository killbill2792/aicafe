import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
const guardedRoutes=[
 "app/api/ai/transcribe/route.ts",
 "app/api/ai/threads/[threadId]/agent/route.ts",
 "app/api/ai/threads/[threadId]/attachments/route.ts",
 "app/api/ai/threads/[threadId]/experiments/route.ts",
 "app/api/ai/threads/[threadId]/proposals/route.ts",
 "app/api/ai/initiatives/[id]/approve/route.ts",
 "app/api/ai/suppliers/research/route.ts",
];
describe("paid provider operations and approval writes require server-side entitlement",()=>{
 for(const path of guardedRoutes){
  it(path,()=>{
   const code=readFileSync(new URL("../../"+path,import.meta.url),"utf8");
   const entry=path.includes("/research/")? "GET": "POST";
   const start=code.indexOf("export async function "+entry+"(");
   expect(start).toBeGreaterThan(0);
   const handler=code.slice(start);
   expect(handler).toMatch(/await assertCafeAiAccess\((?:scope|base)\.businessId\)/);
  });
 }
 it("paid expense server actions are also covered, not only API handlers",()=>{
   for(const [p,fn,gate,provider] of [
     ["lib/actions/receiptReview.ts","reviewReceiptPhoto","requireOwnerAccessScope()","readReceipt(imageDataUrl)"],
     ["lib/actions/voiceReview.ts","reviewVoiceExpense","requireOwnerAccessScope()","parseVoiceExpense(transcript, today)"],
     ["lib/actions/statementReview.ts","reviewStatementCsv","getCafeAccess(businessId)","categorizeLines("],
   ]){
     const src=readFileSync(new URL("../../"+p,import.meta.url),"utf8");
     const method=src.slice(src.indexOf("export async function "+fn+"("));
     expect(method.indexOf(gate)).toBeGreaterThanOrEqual(0);
     expect(method.indexOf(gate)).toBeLessThan(method.indexOf(provider));
   }
   const categorize=readFileSync(new URL("../../lib/expenses/categorize.ts",import.meta.url),"utf8");
   expect(categorize).toContain("allowAi && isAiConfigured()");
 });
 it("rule draft creation also blocks expired owners",()=>{
  const code=readFileSync(new URL("../../app/api/ai/rules/route.ts",import.meta.url),"utf8");
  expect(code.slice(code.indexOf("export async function POST("))).toContain("if(!access.active)");
 });
});
