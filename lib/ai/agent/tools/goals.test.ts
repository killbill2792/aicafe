import {describe,expect,it,vi} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./index";

const ctx=(goals:AgentToolContext["goals"])=>({asOf:"2026-10-01",timezone:"America/Los_Angeles",locale:"en",
  tools:{},goals} as unknown as AgentToolContext);
describe("goal chat tools",()=>{
  it("propose_goal drafts a card through the goal port, mapping the owner's words",async()=>{
    const propose=vi.fn(async()=>({proposalId:"p0000000-0000-4000-8000-000000000001",revision:1,title:"Average ticket up 5%"}));
    const result=await executeAgentTool("propose_goal",{metric:"avg_ticket",item_id:null,direction:"up",
      target_kind:"percent",target:5,days:30,guardrails:[{metric:"orders",item_id:null,direction:"not_below",percent:10}],
      checkin:{question:"Did guests ask about the combo?",cadence:"every_3_days",audience:"staff"}},
      ctx({propose,recordCheckin:vi.fn()}));
    expect(propose).toHaveBeenCalledWith({metric:"avg_ticket",itemId:null,direction:"up",targetKind:"percent",target:5,days:30,
      guardrails:[{metric:"orders",itemId:null,direction:"not_below",percent:10}],
      checkin:{question:"Did guests ask about the combo?",cadence:"every_3_days",audience:"staff"}});
    expect(result).toMatchObject({source:"goal_proposal",draft:true,saved:false,missing:[],title:"Average ticket up 5%"});
  });
  it("rejects goals shorter than a week or longer than 90 days",async()=>{
    for(const days of [3,120])
      await expect(executeAgentTool("propose_goal",{metric:"net_sales",item_id:null,direction:"up",target_kind:"percent",
        target:5,days,guardrails:[],checkin:null},ctx({propose:vi.fn(),recordCheckin:vi.fn()}))).rejects.toThrow();
  });
  it("record_checkin saves the owner's answer through the goal port",async()=>{
    const recordCheckin=vi.fn(async()=>({saved:true}));
    const r=await executeAgentTool("record_checkin",{goal_id:"a0000000-0000-4000-8000-000000000001",date:null,
      answer:"somewhat",note:"Two guests asked"},ctx({propose:vi.fn(),recordCheckin}));
    expect(recordCheckin).toHaveBeenCalledWith("a0000000-0000-4000-8000-000000000001",null,"somewhat","Two guests asked");
    expect(r).toMatchObject({source:"goal_checkin",saved:true});
  });
});
