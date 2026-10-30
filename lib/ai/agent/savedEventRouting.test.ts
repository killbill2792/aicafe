import {beforeEach,describe,expect,it,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import type {AgentToolContext} from "./tools";

const completed={type:"response.completed",response:{usage:{
  input_tokens:35,output_tokens:12,input_tokens_details:{cached_tokens:0},
}}};
function scripted(name:string,args:unknown,answer:string){
  const requests:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function*(params){
    requests.push(params);
    if(requests.length===1){
      yield {type:"response.output_item.done",item:{type:"function_call",name,
        arguments:JSON.stringify(args),call_id:"first-call"}};
      yield completed;
    }else{
      yield {type:"response.output_text.delta",delta:answer};
      yield completed;
    }
  };
  return {provider,requests};
}
const event={id:"one",name:"Town market",status:"moved",sourceUrl:"https://city.example/market",
  startDate:"2026-10-31",endDate:"2026-10-31"};
const savedEvents=vi.fn(async()=>({events:[event],plans:[{
  proposalId:"plan-one",status:"committed",reportStatus:"complete",report:{
    observedDays:1,expectedDays:1,days:[{date:"2026-10-31",actualCents:1200,typicalCents:1100}],
  },
}]})) as unknown as NonNullable<AgentToolContext["savedEvents"]>;
function context(over:Partial<AgentToolContext>={}):AgentToolContext{
  return {locale:"en",asOf:"2026-10-30",timezone:"America/Chicago",
    tools:{} as AgentToolContext["tools"],savedEvents,...over};
}

beforeEach(()=>vi.clearAllMocks());

describe("Supervisor event chat always reuses saved Home facts",()=>{
  it("does not re-run paid discovery even if an older model calls get_nearby_events",async()=>{
    const searchNearbyEvents=vi.fn(async()=>{throw new Error("paid discovery should not run");});
    const webSearch=vi.fn(async()=>{throw new Error("web search should not run");});
    const {provider,requests}=scripted("get_nearby_events",
      {start_date:"2026-10-30",days:3},"The saved town market moved; please check its source.");
    const turn=await runAgentTurn({ownerText:"What changed with our saved town market?",
      context:context({searchNearbyEvents,webSearch}),provider});
    expect(turn.endReason).toBe("complete");
    expect(turn.tools).toEqual(["get_nearby_events"]);
    expect(turn.results[0]).toMatchObject({source:"cafe_events",searched:false,
      events:[{name:"Town market",status:"moved",sourceUrl:"https://city.example/market"}],
      plans:[{status:"committed",reportStatus:"complete"}]});
    expect(savedEvents).toHaveBeenCalledWith("2026-10-30","2026-11-01");
    expect(searchNearbyEvents).not.toHaveBeenCalled();
    expect(webSearch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
  });

  it("permits explicitly requested fresh web research without modifying saved events",async()=>{
    const webSearch=vi.fn(async()=>({available:true as const,
      answer:"City event details updated.",sources:[{title:"City",url:"https://city.example/new"}]}));
    const {provider}=scripted("web_search",
      {query:"City event announcements Austin October 2026"},"The city has posted new event details.");
    const turn=await runAgentTurn({ownerText:"Please search the web for new event announcements",
      context:context({webSearch}),provider});
    expect(turn.tools).toEqual(["web_search"]);
    expect(turn.results[0]).toMatchObject({source:"web_search",sources:[{
      url:"https://city.example/new",
    }]});
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(savedEvents).not.toHaveBeenCalled();
  });
});
