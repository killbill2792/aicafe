import {describe,expect,it,vi} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./index";

const ctx=(goals:AgentToolContext["goals"])=>({asOf:"2026-10-01",timezone:"America/Los_Angeles",locale:"en",
  tools:{},goals} as unknown as AgentToolContext);
describe("goal chat tools",()=>{
  it("propose_goal drafts a card through the goal port, mapping the owner's words",async()=>{
    const propose=vi.fn(async()=>({proposalId:"p0000000-0000-4000-8000-000000000001",revision:1,title:"Average ticket up 5%"}));
    const result=await executeAgentTool("propose_goal",{metric:"avg_ticket",item_id:null,direction:"up",
      target_kind:"percent",target:5,days:30,guardrails:[{metric:"orders",item_id:null,direction:"not_below",percent:10}]},
      ctx({propose,status:vi.fn()}));
    expect(propose).toHaveBeenCalledWith({metric:"avg_ticket",itemId:null,direction:"up",targetKind:"percent",target:5,days:30,
      guardrails:[{metric:"orders",itemId:null,direction:"not_below",percent:10}]});
    expect(result).toMatchObject({source:"goal_proposal",draft:true,saved:false,missing:[],title:"Average ticket up 5%"});
  });
  it("rejects goals shorter than a week or longer than 90 days",async()=>{
    for(const days of [3,120])
      await expect(executeAgentTool("propose_goal",{metric:"net_sales",item_id:null,direction:"up",target_kind:"percent",
        target:5,days,guardrails:[]},ctx({propose:vi.fn(),status:vi.fn()}))).rejects.toThrow();
  });
  it("get_goal_status returns the goal reader's result under the goals source",async()=>{
    const status=vi.fn(async()=>({goals:[{id:"g",title:"Daily sales up 5%"}]}));
    expect(await executeAgentTool("get_goal_status",{goal_id:null},ctx({propose:vi.fn(),status})))
      .toMatchObject({source:"goals",goals:[{title:"Daily sales up 5%"}]});
    expect(status).toHaveBeenCalledWith(null);
  });
  it("says goals are unavailable without a goal port",async()=>{
    expect((await executeAgentTool("get_goal_status",{goal_id:null},ctx(undefined))).missing).toEqual(["not_supported"]);
  });
});
