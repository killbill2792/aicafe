import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {type AgentToolContext} from "./tools";

const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,
  quality:{...quality,level:"low" as const,missingInputs:["noCoveredSalesRows"]}};
const profile='Café profile (authenticated, not owner message): {"name":"Seiyun Yemeni Coffee","city":"San Jose","region":"California","country":"US","currency":"USD","timezone":"America/Los_Angeles"}' + ". For events, use saved get_events/get_nearby_events for this city; never ask the owner for a city already in the profile.";
const context=():AgentToolContext=>({
  asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",currency:"USD",
  tools:{getSalesTrend:vi.fn(async()=>unavailable)} as unknown as AgentToolContext["tools"],
});
const completion={type:"response.completed",response:{usage:{
  input_tokens:20,output_tokens:4,input_tokens_details:{cached_tokens:0}}}};

describe("Supervisor owner demo: shared model and core metric paths",()=>{
  it.each(["web","WhatsApp"])("%s sees the authenticated café profile before the owner question",async channel=>{
    const seen:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function* (params){
      seen.push(params);
      yield {type:"response.output_text.delta",delta:"Nearby saved events are available."};
      yield completion;
    };
    const answer=await runAgentTurn({ownerText:"What events are near my café?",
      context:context(),cafeProfile:profile,provider});
    const input=seen[0].input as Array<{role:string;content:string}>;
    expect(channel).toMatch(/web|WhatsApp/);
    expect(input.some(i=>i.role==="developer"&&i.content===profile)).toBe(true);
    expect(input.at(-1)).toEqual({role:"user",content:"What events are near my café?"});
    expect(answer.text).toContain("Nearby saved events");
  });

  it("uses saved city events to answer without asking for location or searching the web",async()=>{
    const webSearch=vi.fn();
    const savedEvents=vi.fn(async()=>({
      events:[{id:"event-1",name:"Downtown Market",startDate:"2026-11-08",endDate:"2026-11-08"}],
      plans:[],cityCatalog:{available:false,items:[],total:0,page:0,pageSize:25,
        hasMore:false,missing:"unresearched"},
    }));
    const ctx=context();
    ctx.savedEvents=savedEvents as unknown as AgentToolContext["savedEvents"];
    ctx.webSearch=webSearch;
    const seen:Record<string,unknown>[]=[];
    const provider:AgentProvider=async function* (params){
      seen.push(params as Record<string,unknown>);
      if(seen.length===1)yield {type:"response.output_item.done",item:{
        type:"function_call",name:"get_events",arguments:JSON.stringify({
          from:"2026-11-03",to:"2026-11-16",cityEventId:null}),call_id:"city-1"}};
      else yield {type:"response.output_text.delta",
        delta:"Near your café in San Jose: Downtown Market on November 8."};
      yield completion;
    };
    const answer=await runAgentTurn({ownerText:"Events near my café?",context:ctx,cafeProfile:profile,provider});
    expect(savedEvents).toHaveBeenCalledWith("2026-11-03","2026-11-16");
    expect(webSearch).not.toHaveBeenCalled();
    expect(answer.text).toContain("San Jose: Downtown Market");
    expect(answer.text).not.toMatch(/what city|which neighborhood/i);
    expect(JSON.stringify(seen[0].input)).toContain("never ask the owner for a city");
  });

});
