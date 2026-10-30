import {describe,expect,it,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import type {AgentToolContext} from "./tools";

const employeeId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const shiftId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const proposalId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
vi.mock("@/lib/actions/schedule",()=>({getTeam:vi.fn(async()=>({
  ok:true,data:{team:[{id:employeeId,name:"Maria",role:"Barista"}]},
}))}));

const completed={type:"response.completed",response:{usage:{
  input_tokens:42,output_tokens:16,input_tokens_details:{cached_tokens:0},
}}};
const tool=(name:string,args:unknown)=>({type:"response.output_item.done",
  item:{type:"function_call",name,arguments:JSON.stringify(args),call_id:"call-1"}});
const text=(value:string)=>({type:"response.output_text.delta",delta:value});
function scripted(rounds:unknown[][]){
  const requests:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function*(params){
    requests.push(params);
    for(const event of rounds[requests.length-1]??[])yield event as {type:string};
  };
  return {provider,requests};
}
const context={
  locale:"en",asOf:"2026-10-30",timezone:"America/Chicago",
  tools:{getProfitability:vi.fn(),getSalesTrend:vi.fn(),getMenuCatalog:vi.fn()},
} as unknown as AgentToolContext;

describe("event-thread owner questions (recorded tool-call fixtures)",()=>{
  it("answers a parade-route question through the authorized web tool with the source",async()=>{
    const webSearch=vi.fn(async()=>({available:true as const,
      answer:"The parade follows Main Street.",sources:[{title:"City",url:"https://city.example.org/parade"}]}));
    const {requests,provider}=scripted([
      [tool("web_search",{query:"Halloween parade route Austin 2026"}),completed],
      [text("The route follows Main Street. [City route](https://city.example.org/parade)."),completed],
    ]);
    const turn=await runAgentTurn({ownerText:"What's the parade route?",context:{...context,webSearch},provider});
    expect(webSearch).toHaveBeenCalledWith("Halloween parade route Austin 2026");
    expect(turn.tools).toContain("web_search");
    expect(turn.results[0].sources).toEqual([{title:"City",url:"https://city.example.org/parade"}]);
    expect(turn.text).toContain("https://city.example.org/parade");
    expect(turn.usage.toolCalls).toBe(1);
    expect((requests[0].tools as Array<{name:string}>).some(t=>t.name==="web_search")).toBe(true);
  });

  it("writes three drink names without a paid search when public facts are not needed",async()=>{
    const webSearch=vi.fn();
    const {provider}=scripted([[text("Pumpkin Moon, Spooky Spice, Midnight Mocha."),completed]]);
    const turn=await runAgentTurn({ownerText:"Give me 3 Halloween drink names",
      context:{...context,webSearch},provider});
    expect(turn.text).toContain("Pumpkin Moon");
    expect(turn.tools).toEqual([]);
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("routes an event-day shift move to the existing approval proposal, not a direct write",async()=>{
    const proposeStaff=vi.fn(async()=>({proposalId,revision:1,capabilityId:"staff_shift_change"}));
    const proposePriceChange=vi.fn(async()=>{throw new Error("not a price change");});
    const {provider}=scripted([
      [tool("propose_shift_change",{shift_id:shiftId,remove:false,shift:{
        employee_id:employeeId,date:"2026-10-31",start:"15:00",end:"19:00",break_minutes:0,
      }}),completed],
      [text("I have drafted the shift move for your approval."),completed],
    ]);
    const turn=await runAgentTurn({ownerText:"Move Maria's extra Halloween shift to 3pm",context:{
      ...context,proposals:{proposeStaff,proposePriceChange},
    },provider});
    expect(proposeStaff).toHaveBeenCalledWith(expect.objectContaining({name:"propose_shift_change",
      input:expect.objectContaining({shift_id:shiftId,shift:expect.objectContaining({start:"15:00"})})}));
    expect(turn.results).toEqual(expect.arrayContaining([expect.objectContaining({
      source:"staff_proposal",draft:true,saved:false,proposalId,
    })]));
    expect(proposePriceChange).not.toHaveBeenCalled();
    expect(turn.text).toContain("for your approval");
  });
});
