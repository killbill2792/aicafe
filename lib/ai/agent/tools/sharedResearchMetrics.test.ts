import {describe,expect,it} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";

const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const period={from:"2026-03-01",to:"2026-03-10"};
function context(aggregateOnly=false){
 return {asOf:"2026-03-15",timezone:"UTC",locale:"en",
  canonicalData:async()=>({businessId:id,db:{},aggregateOnly}),
  tools:{},readLaborRules:async()=>({ok:true,data:{owner_set:true,min_headcount:2,custom:[{id,rule_text:"Keep handover time"}]}}),goals:{status:async(goalId:string|null)=>({goalId,dailyAverage:15,missing:["partialBaseline"]})}
 } as unknown as AgentToolContext;
}
describe("retired shared reporting selectors",()=>{
 for(const [tool,params,metric] of [
  ["get_product_costs",{itemId:id},{id:"product_cost",entity_id:id}],
  ["get_item_sales",{period,query:null},{id:"item_sales",period}],
  ["get_usage_variance",{...period,ingredient:null,group_by:null},{id:"usage_variance",period}],
  ["get_goal_status",{goal_id:id},{id:"goal_score",entity_id:id}],
  ["get_labor_rules",{},{id:"labor_rules"}]
 ] as const){
  it("keeps "+tool+" internal and does not dispatch it from query_data",async()=>{
   expect(agentToolDefinitions.some(t=>t.name===tool)).toBe(false);
   const ctx=context();
   const internal=await executeAgentTool(tool,params,ctx);
   expect(Array.isArray(internal.missing)).toBe(true);
   expect(await executeAgentTool("query_data",{official_metric:{...metric,period_mode:null}},ctx))
    .toMatchObject({error:"invalid_query"});
  });
 }
 it("does not admit a named reporting selector in an off-turn investigation",async()=>{
  for(const metric of [{id:"goal_score"},{id:"labor_rules"},{id:"usage_variance",period,dimension:"staff"}]){
   expect(await executeAgentTool("query_data",{official_metric:{...metric,period_mode:null}},context(true)))
    .toMatchObject({error:"invalid_query"});
  }
 });
});
