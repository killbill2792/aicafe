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
import {describeU3Catalog} from "./u3SqlResearch.server";

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
   expect(describeU3Catalog).toHaveBeenCalledWith(scope,expect.any(Object));
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
