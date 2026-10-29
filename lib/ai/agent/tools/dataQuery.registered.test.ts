import {describe,it,expect,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";
import {dataQueryTools} from "./dataQuery";

const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const caller=()=> {
 const rpc=vi.fn(async(_name:string,input:Record<string,unknown>)=>({
  data:{rows:[{source:"toast",business_date:"2026-10-20",guest_count:2}],
   sourceCount:1,sourceMix:{toast:1},truncated:false,hasIncomplete:false},error:null
 }));
 const context={
  asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",
  tools:{} as AgentToolContext["tools"],
  canonicalData:async()=>({db:{rpc} as never,businessId})
 } satisfies AgentToolContext;
 return {rpc,context};
};
describe("canonical data available to authenticated chat, not only standalone tools",()=>{
 it("registers both functions for the model and returns the dictionary",async()=>{
  expect(agentToolDefinitions.some(t=>t.name==="describe_data")).toBe(true);
  expect(agentToolDefinitions.some(t=>t.name==="query_data")).toBe(true);
  const result=await executeAgentTool("describe_data",{},caller().context);
  expect(result.source).toBe("canonical_dictionary");
  expect(result.views).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"cv_orders"}),
   expect.objectContaining({name:"cv_cash"}),
   expect.objectContaining({name:"cv_inventory"}),
   expect.objectContaining({name:"cv_kitchen"})
  ]));
 });
 it("routes a scoped chat query through the same safe query RPC",async()=>{
  const {rpc,context}=caller();
  const input={view:"cv_orders",columns:["business_date"],filters:null,
   group_by:["business_date"],metrics:[{fn:"count",column:"guest_count"}],date_from:"2026-10-20",date_to:"2026-10-20",
   order_by:null,limit:25};
  const result=await executeAgentTool("query_data",input,context);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
   p_business_id:businessId,p_view:"cv_orders",p_date_from:"2026-10-20",p_limit:25
  }));
  expect(result).toMatchObject({source:"canonical_data",empty:false});
  expect(result.rows).toHaveLength(1);
 });
 it("never sends a query when the authenticated scope is missing",async()=>{
  const {rpc,context}=caller();
  delete (context as Partial<AgentToolContext>).canonicalData;
  const result=await executeAgentTool("query_data",{
   view:"cv_orders",columns:null,filters:null,group_by:null,metrics:null,
   date_from:"2026-10-20",date_to:"2026-10-20",order_by:null,limit:null
  },context);
  expect(result.missing).toContain("canonical_reader_unavailable");
  expect(rpc).not.toHaveBeenCalled();
 });
 it("query helpers do not accept an arbitrary SQL table or owner-selected business",async()=>{
  const {rpc,context}=caller();
  const result=await dataQueryTools.query_data.execute({
   view:"public.memberships",columns:null,filters:null,group_by:null,metrics:null,
   date_from:"2026-10-20",date_to:"2026-10-20",order_by:null,limit:1
  },await context.canonicalData());
  expect(result.error).toBe("invalid_query");
  expect(rpc).not.toHaveBeenCalled();
 });
});
