import {describe,it,expect,vi} from "vitest";
import {executeAgentTool,agentToolDefinitions,type AgentToolContext} from "./index";
import {questionFromReasons} from "@/lib/ownerFacts/questions";
import {classifyNeedsAsk} from "@/lib/ownerFacts/needsAsk";
import {cafeLocationFrom} from "@/lib/data/cafeLocation.server";
import type {DailyFacts} from "@/lib/calc";
import type {NearbyEventsSearch} from "@/lib/events/nearbyEvents";

const day=(date:string,netSalesCents:number)=>({date,netSalesCents,ordersCount:0,drinksCount:0,ingredientsCents:0,
  wagesCents:null,staffTaxCents:null,cardFeesCents:0,voidsCents:0,salesDataStatus:"actual"}) as DailyFacts;
/** Café history: usual Saturdays $1,500, usual Fridays $1,000, Halloween 2025 (a Friday) $1,320. */
const history=[
  ...["2026-09-05","2026-09-12","2026-09-19","2026-09-26","2026-10-03","2026-10-10","2026-10-17","2026-10-24"].map(d=>day(d,150_000)),
  ...["2026-10-02","2026-10-09","2026-10-16","2026-10-23"].map(d=>day(d,100_000)),
  ...["2025-09-26","2025-10-03","2025-10-10","2025-10-17","2025-10-24"].map(d=>day(d,100_000)),
  day("2025-10-31",132_000),
];
const location={label:"12 Main St, Austin, TX 78701, US",city:"Austin",region:"TX",postalCode:"78701",countryCode:"US",source:"profile" as const};
const aiWeek={name:"Austin AI Week",startDate:"2026-11-02",endDate:"2026-11-05",venue:"Convention Center",distance:"0.4 mi",
  kind:"conference" as const,expectedCrowd:"large" as const,sourceUrl:"https://example.org/ai-week",sourceName:"Example"};

function ctx(over:Partial<AgentToolContext>={}){
  const getSalesTrend=vi.fn(async(p:{from:string;to:string})=>{
    const value=history.filter(d=>d.date>=p.from&&d.date<=p.to);
    return value.length?{available:true as const,value,quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}:
      {available:false as const,value:null,quality:{level:"low" as const,missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}};
  });
  const searchNearbyEvents=vi.fn<NearbyEventsSearch>(async()=>({available:true,events:[aiWeek]}));
  const c={asOf:"2026-10-30",locale:"en",timezone:"America/Chicago",
    tools:{getSalesTrend},cafeLocation:async()=>location,searchNearbyEvents,...over} as unknown as AgentToolContext;
  return {c,getSalesTrend,searchNearbyEvents};
}
type Day={date:string;weekday:string;daysFromToday:number;holidays?:Array<{name:string;usualEffect:string}>;eventIds?:string[];
  typicalSalesCents:number|null;lastTime?:{date:string;changePercent:number;netSalesCents:number;typicalCents:number;holiday:string}|null};

describe("get_nearby_events",()=>{
  it("is offered to the model as a strict tool",()=>{
    const def=agentToolDefinitions.find(d=>d.name==="get_nearby_events");
    expect(def?.strict).toBe(true);
    expect(def?.parameters.required).toEqual(["start_date","days"]);
  });

  it("says tomorrow is Halloween, how last Halloween went, and the AI week nearby",async()=>{
    const {c,searchNearbyEvents}=ctx();
    const r=await executeAgentTool("get_nearby_events",{start_date:null,days:null},c);
    expect(r.period).toEqual({from:"2026-10-30",to:"2026-11-05"});
    expect(r.missing).toEqual([]);
    expect(r.notCovered).toEqual([]);
    const days=r.days as Day[];
    expect(days).toHaveLength(7);
    const tomorrow=days[1];
    expect(tomorrow).toMatchObject({date:"2026-10-31",weekday:"Saturday",daysFromToday:1,typicalSalesCents:150_000});
    expect(tomorrow.holidays?.map(h=>h.name)).toEqual(["Halloween"]);
    // Last Halloween (Friday) vs usual Fridays before it: +32%, from the café's own Toast days.
    expect(tomorrow.lastTime).toEqual({date:"2025-10-31",netSalesCents:132_000,typicalCents:100_000,
      changePercent:32,sampleDays:5,holiday:"Halloween"});
    expect(days[0]).toMatchObject({date:"2026-10-30",weekday:"Friday",typicalSalesCents:100_000});
    expect(days[0].holidays).toEqual([]);
    // The AI week shows on each of its days.
    expect(days.filter(d=>d.eventIds?.includes("e1")).map(d=>d.date)).toEqual(["2026-11-02","2026-11-03","2026-11-04","2026-11-05"]);
    expect(r.localEvents).toEqual([{id:"e1",...aiWeek}]);
    expect(searchNearbyEvents).toHaveBeenCalledWith({location:location.label,city:"Austin",region:"TX",countryCode:"US",
      from:"2026-10-30",to:"2026-11-05"});
  });

  it("without an address still gives holidays and asks for the address, never searching blind",async()=>{
    const {c,searchNearbyEvents}=ctx({cafeLocation:async()=>null});
    const r=await executeAgentTool("get_nearby_events",{start_date:null,days:2},c);
    expect(r.missing).toEqual(["cafe_address"]);
    expect(r.location).toBeNull();
    expect((r.days as Day[])[1].holidays?.map(h=>h.name)).toEqual(["Halloween"]);
    expect(searchNearbyEvents).not.toHaveBeenCalled();
    // The automatic recovery card asks for exactly the address, as a text field.
    const card=questionFromReasons(classifyNeedsAsk([r],"",""),[r],"anything happening nearby?","en",[]);
    expect(card?.fields).toEqual([{key:"cafe_address",label:"your café's address (street, city and ZIP or postal code)",
      inputType:"text",units:[],defaultUnit:""}]);
    expect(card?.question).toContain("nearby events");
    // Once the owner has answered, it is not asked again.
    expect(questionFromReasons(classifyNeedsAsk([r],"",""),[r],"x","en",
      [{fact_key:"cafe_address",value_json:"12 Main St, Austin",created_at:"2026-10-30T00:00:00Z",unit:null,period_scope:null}])).toBeNull();
  });

  it("lets the model ask for the address with a localized text field",async()=>{
    const {c}=ctx();
    c.resolveState={asked:false} as unknown as AgentToolContext["resolveState"];
    const r=await executeAgentTool("ask_owner",{question:"Where is your café?",kind:"facts",options:[],allowOther:false,
      fields:[{key:"cafe_address",label:"Address",inputType:"text",units:[],defaultUnit:"",choices:null}]},{...c,locale:"es"});
    expect(r.missing).toEqual([]);
    expect(r.fields).toEqual([expect.objectContaining({key:"cafe_address",label:"la dirección de tu café (calle, ciudad y código postal)"})]);
  });

  it("keeps the sales and holiday answer when the web search fails",async()=>{
    const {c}=ctx({searchNearbyEvents:async()=>({available:false,reason:"timeout"})});
    const r=await executeAgentTool("get_nearby_events",{start_date:null,days:3},c);
    expect(r.notCovered).toEqual(["localEventsSearchFailed"]);
    expect(r.localEvents).toEqual([]);
    expect(r.localEventsSearched).toBe(false);
    expect(r.missing).toEqual([]); // not something the owner can answer
    expect((r.days as Day[])[1].lastTime?.changePercent).toBe(32);
  });

  it("says when there is no sales history instead of showing zero",async()=>{
    const {c}=ctx();
    (c.tools as {getSalesTrend:unknown}).getSalesTrend=async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
    const r=await executeAgentTool("get_nearby_events",{start_date:null,days:2},c);
    const days=r.days as Day[];
    expect(days[0].typicalSalesCents).toBeNull();
    expect(days[1].lastTime).toBeNull();
    expect(r.notCovered).toEqual(["noSalesHistory"]);
  });

  it("finds Labor Day ahead and compares with last Labor Day",async()=>{
    const labor=[...["2025-07-28","2025-08-04","2025-08-11","2025-08-18","2025-08-25"].map(d=>day(d,80_000)),day("2025-09-01",60_000)];
    const {c}=ctx({asOf:"2026-09-04"});
    (c.tools as {getSalesTrend:unknown}).getSalesTrend=async(p:{from:string;to:string})=>{
      const value=labor.filter(d=>d.date>=p.from&&d.date<=p.to);
      return value.length?{available:true,value,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}:
        {available:false,value:null,quality:{level:"low",missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}};
    };
    const r=await executeAgentTool("get_nearby_events",{start_date:"2026-09-07",days:1},c);
    const [monday]=r.days as Day[];
    expect(monday.holidays?.map(h=>h.name)).toEqual(["Labor Day"]);
    expect(monday.daysFromToday).toBe(3);
    expect(monday.lastTime).toMatchObject({date:"2025-09-01",changePercent:-25});
  });

  it("does not look into the past or too far ahead",async()=>{
    const {c}=ctx();
    const past=await executeAgentTool("get_nearby_events",{start_date:"2026-10-01",days:1},c);
    expect(past.period).toEqual({from:"2026-10-30",to:"2026-10-30"});
    expect(past.notCovered).toEqual(["pastDatesNotCovered"]);
    const far=await executeAgentTool("get_nearby_events",{start_date:"2027-06-01",days:1},c);
    expect(far.notCovered).toEqual(["tooFarAhead"]);
    expect(far.missing).toEqual([]);
  });

  it("never takes a location or café from the model",async()=>{
    const {c}=ctx();
    await expect(executeAgentTool("get_nearby_events",{start_date:null,days:null,location:"Paris"},c)).rejects.toThrow();
  });
});

describe("café location",()=>{
  const row={name:"Main",open_hours:null,address_line1:"12 Main St",address_line2:null,city:"Austin",region:"TX",postal_code:"78701",country_code:"us"};
  const typed=[{fact_key:"cafe_address",value_json:"  5 Elm Rd,  Dallas ",created_at:"2026-10-30T00:00:00Z",unit:null,period_scope:null}];
  it("uses the profile address first, then the owner's typed address",()=>{
    expect(cafeLocationFrom(row,typed)).toEqual({label:"12 Main St, Austin, TX 78701, US",city:"Austin",region:"TX",
      postalCode:"78701",countryCode:"US",source:"profile"});
    expect(cafeLocationFrom({...row,city:null,postal_code:null},typed)).toEqual({label:"5 Elm Rd, Dallas",city:null,
      region:null,postalCode:null,countryCode:"US",source:"owner"});
    expect(cafeLocationFrom(null,[])).toBeNull();
  });
});

describe("owner asks 'anything happening nearby?' in chat",()=>{
  it("runs the tool, keeps the owner's numbers verified, and asks for the address when unknown",async()=>{
    const {runAgentTurn}=await import("../loop.server");
    const completed={type:"response.completed",response:{usage:{input_tokens:40,output_tokens:8,input_tokens_details:{cached_tokens:0}}}};
    const rounds=(reply:string)=>[
      [{type:"response.output_item.done",item:{type:"function_call",name:"get_nearby_events",arguments:"{\"start_date\":null,\"days\":null}",call_id:"c1"}},completed],
      [{type:"response.output_text.delta",delta:reply},completed]];
    const provider=(list:Array<Array<Record<string,unknown>>>)=>{let i=0;
      return async function*(){for(const e of list[i++]??[])yield {...e,type:String(e.type)};};};
    const {c}=ctx();
    const turn=await runAgentTurn({ownerText:"Anything happening nearby?",context:c,
      provider:provider(rounds("Tomorrow is Halloween (Saturday). Last Halloween you sold 32% more than a usual day, so add one person for the afternoon. Austin AI Week runs Nov 2–5 near you."))});
    expect(turn.tools).toContain("get_nearby_events");
    expect(turn.unverified).toEqual([]);
    expect(turn.text).toContain("Halloween");

    const noAddress=ctx({cafeLocation:async()=>null}).c;
    const asked=await runAgentTurn({ownerText:"Anything happening nearby?",context:noAddress,
      provider:provider(rounds("Tomorrow is Halloween. Tell me your address and I'll check local events too."))});
    const card=asked.results.find(r=>r.source==="ask_owner");
    expect(card?.fields).toEqual([expect.objectContaining({key:"cafe_address",inputType:"text"})]);
  });
});

describe("board and chat show the same days",()=>{
  it("the chat tool and the Home card builder return identical days and decisions",async()=>{
    const {buildEventsOutlook}=await import("@/lib/events/outlook");
    const {c}=ctx();
    const chat=await executeAgentTool("get_nearby_events",{start_date:null,days:null},c);
    const board=await buildEventsOutlook({today:"2026-10-30",timezone:"America/Chicago",locale:"en",
      readLocation:async()=>location,search:async()=>({available:true,events:[aiWeek]}),
      readSales:async(from,to)=>history.filter(d=>d.date>=from&&d.date<=to).map(d=>({date:d.date,netSalesCents:d.netSalesCents}))});
    if("tooFarAhead" in board)throw new Error("unexpected");
    expect(chat.days).toEqual(board.days);
    expect(chat.localEvents).toEqual(board.localEvents);
    expect((chat.days as Array<{date:string;decision:unknown}>)[1].decision).toEqual({expect:"busier",action:"add_staff",basis:"your_sales"});
  });
});
