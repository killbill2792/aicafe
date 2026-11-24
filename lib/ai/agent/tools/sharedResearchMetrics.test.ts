import {describe,expect,it} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./index";

const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const period={from:"2026-03-01",to:"2026-03-10"};
function context(aggregateOnly=false){
 return {asOf:"2026-03-15",timezone:"UTC",locale:"en",
  canonicalData:async()=>({businessId:id,db:{},aggregateOnly}),
  tools:{},goals:{status:async(goalId:string|null)=>({goalId,dailyAverage:15,missing:["partialBaseline"]})}
 } as unknown as AgentToolContext;
}
describe("shared research metric selection",()=>{
 for(const [tool,params,metric] of [
  ["get_product_costs",{itemId:id},{id:"product_cost",entity_id:id}],
  ["get_item_sales",{period,query:null},{id:"item_sales",period}],
  ["get_usage_variance",{...period,ingredient:null,group_by:null},{id:"usage_variance",period}],
  ["get_goal_status",{goal_id:id},{id:"goal_score",entity_id:id}]
 ] as const){
  it("preserves the "+tool+" shared definition and missing evidence",async()=>{
   const ctx=context();
   const expected=await executeAgentTool(tool,params,ctx);
   expect(await executeAgentTool("query_data",{official_metric:{...metric,period_mode:null}},ctx))
    .toEqual({...expected,metric_id:metric.id,metric_basis:"official_shared_definition"});
  });
 }
 it("rejects unrelated selectors and owner-private scheduled research",async()=>{
  for(const metric of [{id:"goal_score"},{id:"usage_variance",period,dimension:"staff"}]){
   expect(await executeAgentTool("query_data",{official_metric:{...metric,period_mode:null}},context(true)))
    .toMatchObject({error:"owner_research_required"});
  }
  expect(await executeAgentTool("query_data",{official_metric:{id:"profit",period,entity_id:id,period_mode:null}},context()))
   .toMatchObject({error:"invalid_query"});
 });
});
