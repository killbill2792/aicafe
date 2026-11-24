import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./u3SqlResearch.server",()=>({
  u3SqlConfigured:()=>true,
  safeU3SqlErrorCode:()=> "source_read_failed",
  describeU3Catalog:vi.fn(async()=>{throw new Error("private transport details must not escape");}),
  runU3Sql:vi.fn()
}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
  readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools} from "./dataQuery";
import {executeAgentTool,type AgentToolContext} from "./index";
import {describeU3Catalog,runU3Sql} from "./u3SqlResearch.server";
import {statusFromResults} from "../status";

describe("optional SQL catalog failures",()=>{
  it("surfaces the failure on the primary discovery status, without raw diagnostics",async()=>{
    const data=await dataQueryTools.describe_data.execute(
      {source:"auto",search:"sales"},
      {businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
       ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
       threadId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
       db:{} as never});
    expect(data.source).toBe("canonical_dictionary");
    expect(data.views.length).toBeGreaterThan(0);
    expect(data.missing).toContain("source_read_failed");
    expect(data.error).toBe("source_read_failed");
    expect(data.research).toMatchObject({missing:["source_read_failed"]});
    expect(JSON.stringify(data)).not.toContain("private transport details");
  });
});

describe("real registered SQL discovery carries authenticated scope",()=>{
 const scope={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  threadId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",db:{} as never};
 const context=()=>({asOf:"2026-11-24",timezone:"UTC",locale:"en",
  tools:{} as AgentToolContext["tools"],canonicalData:vi.fn(async()=>scope)} satisfies AgentToolContext);
 it("passes the trusted owner/café/thread context for ordinary research discovery",async()=>{
  const ctx=context();
  for(const raw of [{source:"research",relation:"orders"},{source:"auto",search:"sales"},{}]){
   vi.mocked(describeU3Catalog).mockClear();
   const actual=await executeAgentTool("describe_data",raw,ctx);
   expect(describeU3Catalog).toHaveBeenCalledOnce();
   expect(describeU3Catalog).toHaveBeenCalledWith(expect.objectContaining({...scope,resultBudgetBytes:expect.any(Number)}),expect.objectContaining({search:"sales"}));
   expect(actual.error).toBe("source_read_failed");
   expect(JSON.stringify(actual)).not.toContain("private transport details");
  }
 });
 it("does not obtain a scoped connection for an explicit static canonical lookup",async()=>{
  const ctx=context();
  const actual=await executeAgentTool("describe_data",{source:"canonical",view:"cv_orders"},ctx);
  expect(actual.source).toBe("canonical_dictionary");
  expect(ctx.canonicalData).not.toHaveBeenCalled();
 });
 it("fails closed when the scope cannot be acquired",async()=>{
  const ctx=context();
  ctx.canonicalData.mockRejectedValueOnce(new Error("private auth details"));
  expect(await executeAgentTool("describe_data",{source:"research"},ctx))
   .toMatchObject({source:"u3_semantic_catalog",error:"source_read_failed"});
 });
});

describe("registered SQL repair retains unresolved business gaps, not superseded attempt diagnostics",()=>{
 it("lets a corrected SQL statement supersede the exact failed attempt in the same turn",async()=>{
  const scope={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",db:{} as never};
  const attempts:Array<{callId:string;name:string;arguments:string;result:Awaited<ReturnType<typeof executeAgentTool>>}>=[];
  const ctx={asOf:"2026-11-24",timezone:"UTC",locale:"en",tools:{} as AgentToolContext["tools"],
   canonicalData:async()=>scope,turnResults:()=>attempts} satisfies AgentToolContext;
  const base={view:null,parameters:null,columns:null,filters:null,group_by:null,metrics:null,
   date_from:null,date_to:null,order_by:null,limit:null};
  const run=async(raw:Record<string,unknown>)=>{
   const result=await executeAgentTool("query_data",{...base,...raw},ctx);
   attempts.push({callId:String(attempts.length),name:"query_data",arguments:JSON.stringify(raw),result});
   return result;
  };
  const failed={source:"u3_canonical_research",period:null,missing:["query_syntax_error"],
   rows:[],truncated:false,diagnostic:{reason:"undefined_column",sqlstate:"42703"}};
  const ok={source:"u3_canonical_research",period:null,missing:[],rows:[{amount:"1100"}],truncated:false,page_complete:true};
  vi.mocked(runU3Sql).mockResolvedValueOnce(failed as never).mockResolvedValueOnce(failed as never)
   .mockResolvedValueOnce(failed as never).mockResolvedValueOnce(ok as never);
  const unrelated=await run({sql:"SELECT missing_a FROM orders"});
  const first=await run({sql:"SELECT missing_b FROM orders"});
  const second=await run({sql:"SELECT missing_c FROM orders",retry_of:first.query_attempt_id});
  const repaired=await run({sql:"SELECT sum(net_sales_cents) AS amount FROM orders",retry_of:second.query_attempt_id});
  expect(first.query_attempt_id).toEqual(expect.any(String));
  expect(repaired.replaces_query_attempt_id).toBe(second.query_attempt_id);
  expect(statusFromResults(attempts.slice(1))).toEqual({status:"complete",missing:[]});
  expect(statusFromResults(attempts)).toEqual({status:"partial",missing:["query_syntax_error"]});
  expect(unrelated.query_attempt_id).not.toBe(first.query_attempt_id);
  vi.mocked(runU3Sql).mockResolvedValueOnce(ok as never);
  const foreign=await run({sql:"SELECT count(*) FROM orders",retry_of:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"});
  expect(foreign.replaces_query_attempt_id).toBeUndefined();
 });
});
