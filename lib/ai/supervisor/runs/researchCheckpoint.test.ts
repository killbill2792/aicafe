import {afterEach,describe,expect,it,vi} from "vitest";
import {encryptResearchCheckpoint,decryptResearchCheckpoint} from "./researchCheckpoint.server";
import {calculateTools} from "@/lib/ai/agent/tools/calculate";
import type {AgentToolContext,AgentToolResult} from "@/lib/ai/agent/tools";
import {readRetainedResearch,retainedResearchCatalog} from "@/lib/ai/agent/retainedResearch";
vi.mock("server-only",()=>({}));
afterEach(()=>vi.unstubAllEnvs());
const scope={businessId:"business-a",ownerUserId:"owner-a",threadId:"thread-a",runId:"run-a"};
const operation="11111111-1111-4111-8111-111111111111";
const receipt="22222222-2222-4222-8222-222222222222";
const period={from:"2026-11-01",to:"2026-11-01"};
const source:AgentToolResult={source:"u3_canonical_research",period,missing:[],
 rows:[{amount:"100000",orders:3}],evidence:{receipt_id:receipt,scope:"verified_owner_cafe_lease",column_units:{amount:"cents",orders:"count"}}};
function context(turn:Array<{name:string;result:AgentToolResult}>):AgentToolContext{
 return {asOf:"2026-11-02",timezone:"UTC",locale:"en",turnResults:()=>turn} as AgentToolContext;
}
const input=(name:string,tool:string,path:string,receipt_id:string)=>({name,label:name,tool,path,receipt_id,fact_key:null,owner_value:null,owner_unit:null});
describe("same-run encrypted research continuation",()=>{
 it("authenticates the full scope and operation, without readable private SQL or results",()=>{
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","test-only-private-service-key-123456");
  const raw={sql:"SELECT confidential_amount FROM sales"};
  const cipher=encryptResearchCheckpoint(scope,operation,"query_data",raw,source);
  expect(cipher).not.toContain("confidential_amount");
  expect(cipher).not.toContain("100000");
  expect(decryptResearchCheckpoint(scope,operation,cipher)).toEqual({ref:operation,name:"query_data",arguments:JSON.stringify(raw),result:source});
  for(const key of ["businessId","ownerUserId","threadId","runId"] as const)
   expect(()=>decryptResearchCheckpoint({...scope,[key]:"foreign"},operation,cipher)).toThrow("research_checkpoint_invalid");
  expect(()=>decryptResearchCheckpoint(scope,receipt,cipher)).toThrow("research_checkpoint_invalid");
  const parts=cipher.split(".");parts[2]=(parts[2][0]==="A"?"B":"A")+parts[2].slice(1);
  expect(()=>decryptResearchCheckpoint(scope,operation,parts.join("."))).toThrow("research_checkpoint_invalid");
 });
 it("recovers exact rational results instead of rounded cents on a subsequent worker",async()=>{
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","test-only-private-service-key-123456");
  const raw={purpose:"Average",screen_number:"none",inputs:[input("a","query_data","rows.0.amount",receipt),input("b","query_data","rows.0.orders",receipt)],steps:[{id:"avg",label:"Average",op:"divide",args:["a","b"]}]};
  const first=await calculateTools.calculate.execute(raw,context([{name:"query_data",result:source}]));
  expect(first.result).toEqual({unit:"cents",valueCents:33333});
  const cipher=encryptResearchCheckpoint(scope,operation,"calculate",raw,first);
  const restored=decryptResearchCheckpoint(scope,operation,cipher);
  const id=(first.evidence as {receipt_id:string}).receipt_id;
  const next={purpose:"Original total",screen_number:"none",inputs:[input("a","calculate","result",id),input("b","query_data","rows.0.orders",receipt)],steps:[{id:"total",label:"Total",op:"multiply",args:["a","b"]}]};
  expect(await calculateTools.calculate.execute(next,context([{name:"query_data",result:source},restored]))).toMatchObject({result:{unit:"cents",valueCents:100000}});
  expect((await calculateTools.calculate.execute(next,context([{name:"query_data",result:source},{...restored,result:{...restored.result}}]))).refused).toBe("calculationReceiptUnavailable");
 });
 it("retrieves every retained row in bounded transport pages without inventing another observation",()=>{
  const rows=Array.from({length:317},(_,i)=>({i,amount:"100000"}));
  const reads=[{ref:operation,name:"query_data" as const,arguments:JSON.stringify({sql:"SELECT amount FROM sales"}),result:{...source,rows}}];
  let offset:number|null=0;const collected:unknown[]=[];
  while(offset!==null){
   const page=readRetainedResearch(reads,operation,"result.rows",offset,1400);
   expect(page.error).toBeUndefined();
   expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1400);
   expect(page.original_receipt_id).toBe(receipt);
   collected.push(...page.value as unknown[]);
   offset=page.next_offset as number|null;
  }
  expect(collected).toEqual(rows);
  expect(readRetainedResearch(reads,operation,"result.__proto__",0,1400).error).toBe("invalid_retained_path");
  expect(readRetainedResearch(reads,"foreign","result.rows",0,1400).error).toBe("retained_receipt_unavailable");
  expect(retainedResearchCatalog(reads,0,null,1400)).toMatchObject({total:1,truncated:false,entries:[{ref:operation,receipt_id:receipt,rows:317}]});
 });
});
