import {describe,expect,it,vi} from "vitest";
import {eventScanWindows} from "./eventsLookahead";
import {CITY_RESEARCH_MAX_OUTPUT_TOKENS,cityResearchDateSlices,cityResearchJsonSchema,
  defaultCityResearchSources,parseCityResearchEvents,type CityResearchSource} from "./citySourceResearch";
import {createCitySourceResearch} from "./citySourceResearch.server";

const venue:CityResearchSource={id:"civic",kind:"venue",name:"Official Civic Center Calendar",
  officialUrl:"https://civic.example.org/calendar"};
const campus:CityResearchSource={id:"campus",kind:"university",name:"University Events",
  officialUrl:"https://university.example.org/events"};
const event=(name:string,day="2026-11-04",source="https://civic.example.org/events/1")=>
  ({name,startDate:day,sourceUrl:source});
const completed=(items:unknown[])=>new Response(JSON.stringify({status:"completed",
  output:[{type:"web_search_call",status:"completed"},
    {type:"message",content:[{type:"output_text",text:JSON.stringify({events:items})}]}]}),{status:200});
const incomplete=()=>new Response(JSON.stringify({status:"incomplete",
  incomplete_details:{reason:"max_output_tokens"},output:[{type:"reasoning",summary:[]}]}),{status:200});
const input=(window:{from:string;to:string;reason:"initial"|"weekly"|"new_day"},
  sources:CityResearchSource[]=[venue,campus])=>({
    city:"Austin",region:"TX",countryCode:"US",window,sources
  });
const now=()=>new Date("2026-11-03T16:00:00Z");

describe("LDI B city research contract",()=>{
  it("reuses the existing three-field strict JSON response and 1200-token ceiling",()=>{
    const item=cityResearchJsonSchema.properties.events.items;
    expect(item.required).toEqual(["name","startDate","sourceUrl"]);
    expect(Object.keys(item.properties)).toEqual(["name","startDate","sourceUrl"]);
    expect(CITY_RESEARCH_MAX_OUTPUT_TOKENS).toBe(1200);
    expect(defaultCityResearchSources().map(s=>s.kind)).toEqual([
      "city_calendar","convention","university","festival","sports","arts","general"
    ]);
  });
  it("uses lookahead's actual initial 14-day, one entering day, and Monday windows",()=>{
    const first=eventScanWindows("2026-11-03",null,"addr")[0];
    expect(first).toEqual({from:"2026-11-03",to:"2026-11-16",reason:"initial"});
    expect(cityResearchDateSlices(first.from,first.to)).toEqual([
      {from:"2026-11-03",to:"2026-11-09"},{from:"2026-11-10",to:"2026-11-16"}
    ]);
    const state={locationHash:"addr",scannedThroughDate:"2026-11-16",weeklyResearchedOn:null};
    const daily=eventScanWindows("2026-11-04",state,"addr")[0];
    expect(daily).toEqual({from:"2026-11-17",to:"2026-11-17",reason:"new_day"});
    expect(cityResearchDateSlices(daily.from,daily.to)).toEqual([
      {from:"2026-11-17",to:"2026-11-17"}
    ]);
    const monday=eventScanWindows("2026-11-09",state,"addr")[0];
    expect(monday).toEqual({from:"2026-11-09",to:"2026-11-22",reason:"weekly"});
    expect(cityResearchDateSlices(monday.from,monday.to)).toHaveLength(2);
    expect(()=>cityResearchDateSlices("2026-11-03","2026-11-17")).toThrow();
  });
  it("returns source provenance and >8 events across bounded sources/windows",async()=>{
    const web=vi.fn(async(_url:string|URL|Request,options?:RequestInit)=>{
      const body=JSON.parse(String(options?.body)) as {input:string};
      const range=/from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/u.exec(body.input)!;
      const prefix=body.input.includes("University")?"University":"Civic";
      const origin=prefix==="Civic"?"civic":"university";
      const dates=range[1]==="2026-11-03"?
        ["2026-11-03","2026-11-04","2026-11-05","2026-11-06"]:
        ["2026-11-10","2026-11-11","2026-11-12","2026-11-13"];
      return completed(dates.map((day,i)=>event(prefix+" Event "+day,day,
        "https://"+origin+".example.org/events/"+i)));
    });
    const result=await createCitySourceResearch({fetch:web as typeof fetch,apiKey:"test",
      model:"small",now})(input(eventScanWindows("2026-11-03",null,"a")[0]));
    expect(result.events).toHaveLength(16);
    expect(result.sources).toHaveLength(4);
    expect(result.sources.every(s=>s.outcome==="found"&&s.retryEligible===false)).toBe(true);
    expect(result.sources[0]).toMatchObject({sourceId:"civic",sourceKind:"venue",
      from:"2026-11-03",to:"2026-11-09",reason:"initial",
      checkedAt:"2026-11-03T16:00:00.000Z",officialUrl:venue.officialUrl});
    expect(result.partial).toBe(false);
    expect(result.retrySourceIds).toEqual([]);
    expect(web).toHaveBeenCalledTimes(4);
    const body=JSON.parse(String(web.mock.calls[0][1]?.body));
    expect(body).toMatchObject({store:false,max_output_tokens:1200,
      text:{format:{strict:true,type:"json_schema",name:"nearby_events"}},
      tools:[{type:"web_search",user_location:{type:"approximate",city:"Austin",region:"TX",country:"US"}}]});
    expect(Object.keys(result.events[0]).sort()).toEqual(["name","sourceUrl","startDate"]);
  });
  it("rediscovers Monday events without inventing cancellation or carrying events from another run",async()=>{
    let newest=false;
    const web=vi.fn(async()=>completed(newest?[event("New city parade","2026-11-12")]:[]));
    const research=createCitySourceResearch({fetch:web,apiKey:"test",now});
    const state={locationHash:"addr",scannedThroughDate:"2026-11-16",weeklyResearchedOn:null};
    const daily=await research(input(eventScanWindows("2026-11-04",state,"addr")[0],[venue]));
    expect(daily.sources).toHaveLength(1);
    expect(daily.sources[0].outcome).toBe("none_found");
    newest=true;
    const monday=await research(input(eventScanWindows("2026-11-09",state,"addr")[0],[venue]));
    expect(monday.events).toEqual([event("New city parade","2026-11-12")]);
    expect(monday.sources.map(s=>s.reason)).toEqual(["weekly","weekly"]);
  });
  it("recovers a 200 incomplete response using one plain retry, never raising the token cap",async()=>{
    const web=vi.fn().mockImplementationOnce(async()=>incomplete())
      .mockImplementationOnce(async()=>completed([event("Student conference")]));
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-04",to:"2026-11-04",reason:"new_day"},[venue]));
    expect(result.events).toHaveLength(1);
    expect(result.sources[0].outcome).toBe("found");
    expect(web).toHaveBeenCalledTimes(2);
    const first=JSON.parse(String(web.mock.calls[0][1].body));
    const second=JSON.parse(String(web.mock.calls[1][1].body));
    expect(first.text.format.strict).toBe(true);
    expect(second.text).toBeUndefined();
    expect([first.max_output_tokens,second.max_output_tokens]).toEqual([1200,1200]);
  });
  it("keeps a successful source while another times out or receives 503; both remain distinct",async()=>{
    const web=vi.fn(async(_url:string|URL|Request,options?:RequestInit)=>{
      const body=JSON.parse(String(options?.body)) as {input:string};
      return body.input.includes("University")?new Response("unavailable",{status:503}):
        completed([event("Civic market")]);
    });
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-04",to:"2026-11-04",reason:"new_day"}));
    expect(result.events).toEqual([event("Civic market")]);
    expect(result.sources.map(s=>[s.sourceId,s.outcome,s.failure,s.retryEligible])).toEqual([
      ["civic","found",null,false],["campus","failed","http_error",true]
    ]);
    expect(result.partial).toBe(true);
    expect(result.retrySourceIds).toEqual(["campus"]);
    expect(web).toHaveBeenCalledTimes(3);
  });
  it("does not call a failed venue, 403, or absent key an empty successful scan",async()=>{
    const web=vi.fn(async()=>new Response("forbidden",{status:403}));
    const scope={from:"2026-11-04",to:"2026-11-04",reason:"new_day"} as const;
    const failed=await createCitySourceResearch({fetch:web,apiKey:"test",now})(input(scope,[venue]));
    expect(failed.sources[0]).toMatchObject({outcome:"failed",failure:"http_error",retryEligible:false});
    expect(failed.partial).toBe(true);
    expect(web).toHaveBeenCalledTimes(1);
    const noKey=await createCitySourceResearch({fetch:web,apiKey:"",now})(input(scope,[venue]));
    expect(noKey.sources[0]).toMatchObject({outcome:"failed",failure:"not_configured"});
    expect(web).toHaveBeenCalledTimes(1);
  });
  it("does not accept fabricated dates, unsourced events, or another host posing as official",()=>{
    expect(parseCityResearchEvents(JSON.stringify({events:[
      event("Invented event","2026-02-30"),
    ]}),"2026-02-01","2026-02-28",venue)).toBeNull();
    expect(parseCityResearchEvents(JSON.stringify({events:[{
      name:"Unverified event",startDate:"2026-11-04"
    }]}),"2026-11-04","2026-11-04",venue)).toBeNull();
    const parsed=parseCityResearchEvents(JSON.stringify({events:[
      event("Official concert"),event("Fake official URL","2026-11-04",
        "https://civic.example.org.evil.test/show")
    ]}),"2026-11-04","2026-11-04",venue);
    expect(parsed).toMatchObject({events:[event("Official concert")],filtered:true});
  });
  it("keeps a good event but marks rejected dated listings as incomplete coverage",async()=>{
    const web=vi.fn(async()=>completed([
      event("Verified market"),event("Impossible date","2026-11-31")
    ]));
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-04",to:"2026-11-04",reason:"new_day"},[venue]));
    expect(result.events).toEqual([event("Verified market")]);
    expect(result.sources[0]).toMatchObject({outcome:"partial",retryEligible:true});
    expect(result.retrySourceIds).toEqual(["civic"]);
  });
  it("counts retries against the provider request cap, not logical windows",async()=>{
    const web=vi.fn(async()=>incomplete());
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",
      now,maxSearches:1})(input({from:"2026-11-04",to:"2026-11-04",
      reason:"new_day"},[venue]));
    expect(web).toHaveBeenCalledTimes(1);
    expect(result.sources[0]).toMatchObject({
      outcome:"failed",failure:"request_budget",retryEligible:true
    });
  });
  it("reports cross-domain source filtering as partial and schedules retry",async()=>{
    const web=vi.fn(async()=>completed([event("Bad source","2026-11-04",
      "https://unrelated.example.net/event")]));
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-04",to:"2026-11-04",reason:"new_day"},[venue]));
    expect(result.events).toEqual([]);
    expect(result.sources[0]).toMatchObject({outcome:"partial",retryEligible:true});
    expect(result.retrySourceIds).toEqual(["civic"]);
  });
  it("deduplicates cross-source candidates without dropping source evidence",async()=>{
    const shared=event("Austin Art Festival","2026-11-04","https://civic.example.org/festival");
    const web=vi.fn(async(_url:string|URL|Request,options?:RequestInit)=>{
      const body=JSON.parse(String(options?.body)) as {input:string};
      return completed([body.input.includes("University")?
        {...shared,sourceUrl:"https://university.example.org/festival"}:shared]);
    });
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-04",to:"2026-11-04",reason:"new_day"}));
    expect(result.events).toEqual([shared]);
    expect(result.duplicateCount).toBe(1);
    expect(result.sources.map(s=>s.events.length)).toEqual([1,1]);
  });
  it("splits a saturated 5-event venue window and finds events beyond the first response",async()=>{
    const web=vi.fn(async(_url:string|URL|Request,options?:RequestInit)=>{
      const prompt=JSON.parse(String(options?.body)).input as string;
      const range=/from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/u.exec(prompt)!;
      if(range[1]==="2026-11-03"&&range[2]==="2026-11-09")
        return completed(Array.from({length:5},(_,i)=>event("Market "+i,"2026-11-04")));
      const day=range[1];
      return completed([event("Additional "+day,day)]);
    });
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now})(
      input({from:"2026-11-03",to:"2026-11-09",reason:"initial"},[venue]));
    expect(web.mock.calls.length).toBeGreaterThan(1);
    expect(result.events.some(e=>e.name==="Additional 2026-11-03")).toBe(true);
    expect(result.events.some(e=>e.name==="Market 0")).toBe(true);
  });
  it("exposes budget exhaustion as retryable partial coverage, not none_found",async()=>{
    const web=vi.fn(async()=>completed([]));
    const result=await createCitySourceResearch({fetch:web,apiKey:"test",now,
      maxSearches:1})(input({from:"2026-11-03",to:"2026-11-16",reason:"initial"},[venue]));
    expect(web).toHaveBeenCalledTimes(1);
    expect(result.sources.map(s=>[s.outcome,s.failure])).toEqual([
      ["none_found",null],["failed","request_budget"]
    ]);
    expect(result.retrySourceIds).toEqual(["civic"]);
    expect(result.partial).toBe(true);
  });
});
