import {beforeEach,afterEach,describe,it,expect} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {paidRequestReservation,reserveTask14bPaidRequest,
 TASK14B_MAX_PAID_CALLS,TASK14B_MAX_RESERVED_MICROS} from "./task14bPaidBudget.server";

const head="a".repeat(40);
const vars=["AICAFE_TASK14B_BUDGET_LEDGER","AI_CAFE_LIVE_ACCEPTANCE",
 "APP_URL","NEXT_PUBLIC_SUPABASE_URL","HEAD_SHA"] as const;
let root="",file="";
const saved=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const params={model:"gpt-6-luna",max_output_tokens:1200,
 service_tier:"standard",tools:[{type:"function",name:"inspect_supplier_purchase"}]};
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),"task14b-budget-"));file=join(root,"ledger.json");
 writeFileSync(file,JSON.stringify({head,attempts:0,reservedMicros:0}));
 process.env.AICAFE_TASK14B_BUDGET_LEDGER=file;
 process.env.AI_CAFE_LIVE_ACCEPTANCE="OWNER_APPROVED_LOCAL_ONLY";
 process.env.APP_URL="http://127.0.0.1:3000";
 process.env.NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321";
 process.env.HEAD_SHA=head;
});
afterEach(()=>{
 for(const k of vars){
  if(saved[k]===undefined)delete process.env[k];
  else process.env[k]=saved[k];
 }
 rmSync(root,{recursive:true,force:true});
});
describe("Task14B owner $0.80 hard-budget / $0.18 reservation gate",()=>{
 it("rejects unknown models, tiers, tools, output sizes and 120k input before spending",()=>{
  const p=JSON.stringify(params);
  expect(paidRequestReservation(params,p).reservedMicros).toBeGreaterThan(0);
  for(const bad of [
   {...params,model:"gpt-4.1-mini"},
   {...params,service_tier:"priority"},
   {...params,tools:[{type:"web_search_preview"}]},
   {...params,max_output_tokens:1201}, // missing tool_choice retains legacy limit
   {...params,tool_choice:"auto",max_output_tokens:16385},
   {...params,tool_choice:"none",max_output_tokens:1201},
   {...params,background:true},
  ])expect(()=>paidRequestReservation(bad,JSON.stringify(bad))).toThrow(/task14b_budget:/);
  expect(()=>paidRequestReservation(params,"x".repeat(120001))).toThrow("task14b_budget:input_limit");
 });
 it("atomically reserves retries and concurrent calls, blocks the nineteenth",async()=>{
  const body=JSON.stringify(params);
  const results=await Promise.allSettled(Array.from({length:TASK14B_MAX_PAID_CALLS+2},
    ()=>reserveTask14bPaidRequest(params,body)));
  expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(TASK14B_MAX_PAID_CALLS);
  expect(results.filter(x=>x.status==="rejected")).toHaveLength(2);
  const record=JSON.parse(readFileSync(file,"utf8"));
  expect(record).toMatchObject({head,attempts:TASK14B_MAX_PAID_CALLS});
  expect(record.reservedMicros).toBeLessThanOrEqual(TASK14B_MAX_RESERVED_MICROS);
  await expect(reserveTask14bPaidRequest(params,body))
   .rejects.toThrow("task14b_budget:paid_ceiling_reached");
 });
 it("blocks a wrong-head state or nonlocal environment without consuming budget",async()=>{
  const body=JSON.stringify(params);
  process.env.HEAD_SHA="b".repeat(40);
  await expect(reserveTask14bPaidRequest(params,body))
   .rejects.toThrow("task14b_budget:wrong_head_or_ledger");
  process.env.HEAD_SHA=head;
  process.env.APP_URL="https://production.example.com";
  await expect(reserveTask14bPaidRequest(params,body))
   .rejects.toThrow("task14b_budget:disposable_environment_required");
  expect(JSON.parse(readFileSync(file,"utf8")).attempts).toBe(0);
 });
 it("reserves worst-case input without caching discount and never over-reserves cap",async()=>{
  const large={...params,max_output_tokens:1200};
  const json=JSON.stringify({...large,input:"x".repeat(90000)});
  const cost=paidRequestReservation(large,json).reservedMicros;
  expect(cost).toBeGreaterThan(9000);
  let successes=0;
  for(let i=0;i<30;i++){
   try{await reserveTask14bPaidRequest(large,json);successes++}catch(e){
    expect(String(e)).toContain("task14b_budget:paid_ceiling_reached");
    break;
   }
  }
  const record=JSON.parse(readFileSync(file,"utf8"));
  expect(record.attempts).toBe(successes);
  expect(record.reservedMicros).toBeLessThanOrEqual(TASK14B_MAX_RESERVED_MICROS);
  expect(successes).toBeLessThanOrEqual(TASK14B_MAX_PAID_CALLS);
 });
});

it("reserves the entire 16384-token tool request under the unchanged aggregate ledger cap",async()=>{
 const expanded={...params,tool_choice:"auto",max_output_tokens:16384};
 const json=JSON.stringify(expanded);
 expect(paidRequestReservation(expanded,json).reservedMicros).toBe(Math.ceil(Buffer.byteLength(json)*0.10+16384*0.50));
 await reserveTask14bPaidRequest(expanded,json);
 expect(JSON.parse(readFileSync(file,"utf8"))).toMatchObject({attempts:1,reservedMicros:paidRequestReservation(expanded,json).reservedMicros});
 const final={...params,tool_choice:"none",max_output_tokens:1200};
 expect(paidRequestReservation(final,JSON.stringify(final)).reservedMicros).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(final))*0.10+1200*0.50));
});
