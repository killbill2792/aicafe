import {describe,it,expect,vi,beforeEach} from "vitest";
import {parseNearbyEvents,responseOutputText,nearbyEventsPrompt,MAX_EVENTS} from "./nearbyEvents";
import {createNearbyEventsSearch,clearNearbyEventsCache,SEARCH_MAX_OUTPUT_TOKENS} from "./nearbyEventsSearch.server";
import {holidaysBetween} from "./holidays";

const event=(over:Record<string,unknown>={})=>({name:"Austin AI Week",startDate:"2026-11-02",endDate:"2026-11-06",
  venue:"Convention Center",venueAddress:"500 E Cesar Chavez St, Austin, TX",
  startTime:"09:00",endTime:"18:00",distance:"downtown",kind:"conference",expectedCrowd:"large",
  sourceUrl:"https://example.org/ai-week",sourceName:"Example",...over});

describe("parsing searched events",()=>{
  it("keeps valid events in the window and drops invented or broken ones",()=>{
    const text=JSON.stringify({events:[event(),
      event({name:"Old fair",startDate:"2026-10-01",endDate:"2026-10-02"}), // before the window
      event({name:"Later fair",startDate:"2026-12-01",endDate:null}),        // after the window
      event({name:"No source",sourceUrl:"not a url"}),
      event({name:"Bad date",startDate:"31/10/2026"}),
      event(), // duplicate
      event({name:"Halloween parade",startDate:"2026-10-31",endDate:null,kind:"weird",expectedCrowd:"huge"})]});
    const out=parseNearbyEvents(text,"2026-10-30","2026-11-05");
    expect(out?.map(e=>[e.name,e.startDate,e.endDate,e.kind,e.expectedCrowd])).toEqual([
      ["Austin AI Week","2026-11-02","2026-11-06","conference","large"],
      ["Halloween parade","2026-10-31","2026-10-31","other","unknown"]]);
  });
  it("keeps an event that started before the window but is still on",()=>{
    const out=parseNearbyEvents(JSON.stringify({events:[event({startDate:"2026-10-28",endDate:"2026-11-01"})]}),"2026-10-30","2026-11-05");
    expect(out).toHaveLength(1);
  });
  it("caps the list and rejects non-JSON",()=>{
    const many={events:Array.from({length:12},(_,i)=>event({name:"Event "+i}))};
    expect(parseNearbyEvents("```json\n"+JSON.stringify(many)+"\n```","2026-10-30","2026-11-05")).toHaveLength(MAX_EVENTS);
    expect(parseNearbyEvents("sorry, I could not search","2026-10-30","2026-11-05")).toBeNull();
    expect(parseNearbyEvents(JSON.stringify({events:[]}),"2026-10-30","2026-11-05")).toEqual([]);
    // A broken "events" list is not an empty successful search.
    expect(parseNearbyEvents(JSON.stringify({events:[{name:"No source"}]}),
      "2026-10-30","2026-11-05")).toBeNull();
    expect(parseNearbyEvents(JSON.stringify({events:[event({startDate:"2026-12-01",endDate:null})]}),
      "2026-10-30","2026-11-05")).toBeNull();
  });
  it("reads the text of a Responses API result",()=>{
    expect(responseOutputText({output:[{type:"web_search_call"},
      {type:"message",content:[{type:"output_text",text:"{\"events\":"},{type:"output_text",text:"[]}"}]}]})).toBe("{\"events\":[]}");
    expect(responseOutputText({output:[]})).toBeNull();
  });
  it("asks for confirmed dates only and names Halloween events",()=>{
    const p=nearbyEventsPrompt("12 Main St, Austin, TX 78701, US","2026-10-30","2026-11-05");
    expect(p).toContain("12 Main St, Austin, TX 78701, US");
    expect(p).toContain("2026-10-30 to 2026-11-05");
    expect(p).toMatch(/Never guess or invent/u);
    expect(p).toMatch(/Halloween/u);
  });
});

describe("web search call",()=>{
  beforeEach(()=>clearNearbyEventsCache());
  const input={location:"12 Main St, Austin, TX 78701, US",city:"Austin",region:"TX",countryCode:null,from:"2026-10-30",to:"2026-11-05"};
  const ok=(events:unknown[])=>new Response(JSON.stringify({output:[{type:"message",
    content:[{type:"output_text",text:JSON.stringify({events})}]}]}),{status:200});

  it("searches with the hosted web search tool near the café and strict JSON",async()=>{
    const fetch=vi.fn<(url:string|URL|Request,init?:RequestInit)=>Promise<Response>>(async()=>ok([event()]));
    const search=createNearbyEventsSearch({fetch:fetch as unknown as typeof globalThis.fetch,apiKey:"k",model:"m"});
    const r=await search(input);
    expect(r).toEqual({available:true,outcome:"found",events:[expect.objectContaining({name:"Austin AI Week",
      venueAddress:"500 E Cesar Chavez St, Austin, TX",startTime:"09:00"})],partial:false,failedSearches:[]});
    const body=JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.tools).toEqual([{type:"web_search",user_location:{type:"approximate",city:"Austin",region:"TX"}}]);
    expect(body.text.format).toMatchObject({type:"json_schema",strict:true,name:"nearby_events"});
    expect(body.max_output_tokens).toBe(SEARCH_MAX_OUTPUT_TOKENS);
    expect(body.store).toBe(false);
    // Same place and dates within a few hours: no second paid search.
    await search(input);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("falls back to the preview tool name once on a 400",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response("{}",{status:400})).mockResolvedValueOnce(ok([]));
    const r=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(r).toEqual({available:true,outcome:"none_found",events:[],partial:false});
    expect(JSON.parse(String(fetch.mock.calls[1][1].body)).tools[0].type).toBe("web_search_preview");
  });
  it("asks for plain JSON when the model rejects strict JSON with web search",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response("{}",{status:400})).mockResolvedValueOnce(new Response("{}",{status:400}))
      .mockResolvedValueOnce(new Response(JSON.stringify({output:[{type:"message",content:[{type:"output_text",
        text:"```json\n"+JSON.stringify({events:[event()]})+"\n```"}]}]}),{status:200}));
    const r=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(r).toEqual({available:true,outcome:"found",events:[expect.objectContaining({name:"Austin AI Week"})],partial:false,failedSearches:[]});
    const last=JSON.parse(String(fetch.mock.calls[2][1].body));
    expect(last.tools[0].type).toBe("web_search");
    expect(last.text).toBeUndefined();
    expect(last.input).toMatch(/Respond with only a JSON object/u);
  });
  it("reports failures without logging the address",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    const fetch=vi.fn().mockResolvedValue(new Response("nope",{status:500}));
    expect(await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input)).toEqual({available:false,outcome:"failed",reason:"searchFailed",category:"http_error"});
    const timeout=vi.fn().mockRejectedValue(Object.assign(new Error("t"),{name:"TimeoutError"}));
    expect(await createNearbyEventsSearch({fetch:timeout,apiKey:"k",model:"m"})(input)).toEqual({available:false,outcome:"failed",reason:"timeout",category:"timeout"});
    expect(JSON.stringify(log.mock.calls)).not.toContain("Main St");
    log.mockRestore();
  });

  // Captured Responses API structures: the HTTP request succeeded, but no usable JSON arrived.
  const incomplete={id:"resp_incomplete",status:"incomplete",incomplete_details:{reason:"max_output_tokens"},
    output:[{type:"web_search_call",status:"completed"},{type:"reasoning",summary:[]}]};
  const reasoningOnly={id:"resp_reasoning",status:"completed",output:[{type:"web_search_call",status:"completed"},
    {type:"reasoning",summary:[]}]};
  const prose={id:"resp_prose",status:"completed",output:[{type:"message",role:"assistant",
    content:[{type:"output_text",text:"I found events, but I cannot return JSON."}]}]};
  const fenced={id:"resp_fenced",status:"completed",output:[{type:"message",role:"assistant",
    content:[{type:"output_text",text:"\x60\x60\x60json\n"+JSON.stringify({events:[event()]})+"\n\x60\x60\x60"}]}]};

  it.each([
    ["incomplete",incomplete,"incomplete"],
    ["reasoning-only",reasoningOnly,"missing_message"],
    ["prose",prose,"invalid_json"],
    ["empty text",{status:"completed",output:[{type:"message",content:[{type:"output_text",text:"  "}]}]},"empty_text"],
    ["invalid shape",{status:"completed",output:[{type:"message",content:[{type:"output_text",text:"{}"}]}]},"invalid_shape"],
  ])("retries HTTP 200 %s once as plain JSON",async(_label,fixture,category)=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(fixture),{status:200}))
      .mockResolvedValueOnce(ok([]));
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(result).toEqual({available:true,outcome:"none_found",events:[],partial:false});
    expect(fetch).toHaveBeenCalledTimes(2);
    const second=JSON.parse(String(fetch.mock.calls[1][1].body));
    expect(second.text).toBeUndefined();
    const logs=info.mock.calls.map(c=>c[1] as Record<string,unknown>);
    expect(logs[0]).toMatchObject({attempt:1,httpStatus:200,parseFailure:category});
    expect(logs[1]).toMatchObject({attempt:2,format:"plain",parseFailure:null});
    expect(logs[0].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(logs)).not.toContain("Main St");
    info.mockRestore();
  });

  it("accepts fenced JSON without retrying",async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(fenced),{status:200}));
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(result).toMatchObject({available:true,outcome:"found",events:[{name:"Austin AI Week"}]});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a typed failure when HTTP 200 and plain retry both lack a message",async()=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    const fetch=vi.fn(async()=>new Response(JSON.stringify(reasoningOnly),{status:200}));
    expect(await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input))
      .toEqual({available:false,outcome:"failed",reason:"searchFailed",category:"missing_message"});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([...info.mock.calls,...error.mock.calls])).not.toContain("Main St");
    expect(error).toHaveBeenCalledWith("nearby_events_search_failed",
      expect.objectContaining({category:"missing_message",failedQueries:1}));
    info.mockRestore();error.mockRestore();
  });

  it("searches each holiday as well as the general window and de-duplicates",async()=>{
    const halloween=holidaysBetween("2026-10-30","2026-10-31","US","TX","en")
      .find(h=>/halloween/iu.test(h.name));
    expect(halloween).toEqual(expect.objectContaining({date:"2026-10-31"}));
    const fetch=vi.fn(async (_url:string|URL|Request,_init?:RequestInit)=>ok([event({name:"Halloween parade",
      startDate:"2026-10-31",endDate:null})]));
    const search=createNearbyEventsSearch({fetch,apiKey:"k",model:"m"});
    const result=await search({...input,countryCode:"US",to:"2026-10-31"});
    expect(result).toMatchObject({available:true,outcome:"found",partial:false});
    if(result.available)expect(result.events.map(e=>e.name)).toEqual(["Halloween parade"]);
    const bodies=fetch.mock.calls.map(c=>JSON.parse(String(c[1]?.body)) as {input:string});
    expect(bodies.some(b=>b.input.includes("Dates: 2026-10-30 to 2026-10-31"))).toBe(true);
    expect(bodies.some(b=>b.input.includes("Halloween events near"))).toBe(true);
    expect(fetch.mock.calls.length).toBe(1+holidaysBetween("2026-10-30","2026-10-31","US","TX","en").length);
    await search({...input,countryCode:"US",to:"2026-10-31"});
    expect(fetch).toHaveBeenCalledTimes(bodies.length);
  });

  it("keeps partial findings without caching a failed holiday scope",async()=>{
    const fetch=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {input:string};
      if(request.input.includes("Search specifically for Halloween"))
        return new Response("service unavailable",{status:503});
      return ok([event({name:"Halloween parade",startDate:"2026-10-31",endDate:null})]);
    });
    const search=createNearbyEventsSearch({fetch,apiKey:"k",model:"m"});
    const params={...input,countryCode:"US",to:"2026-10-31"};
    const result=await search(params);
    expect(result).toMatchObject({available:true,outcome:"found",partial:true,
      failedSearches:[{kind:"holiday",name:"Halloween",date:"2026-10-31"}]});
    if(result.available)expect(result.events.map(e=>e.name)).toEqual(["Halloween parade"]);
    const calls=fetch.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(await search(params)).toEqual(result);
    // In contrast to a complete search, partial scopes are retried on next scan.
    expect(fetch).toHaveBeenCalledTimes(calls*2);
  });

  it("flags a failed general search while retaining successful holiday events",async()=>{
    const fetch=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {input:string};
      return request.input.startsWith("Search the web for public events")?
        new Response("service unavailable",{status:503}):
        ok([event({name:"Halloween parade",startDate:"2026-10-31",endDate:null})]);
    });
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(
      {...input,countryCode:"US",to:"2026-10-31"});
    expect(result).toMatchObject({available:true,outcome:"found",partial:true,
      failedSearches:[{kind:"general"}],
      events:[{name:"Halloween parade"}]});
  });

  it("recovers from a 25-second timeout on one bounded plain-JSON retry",async()=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    try{
      const fetch=vi.fn().mockRejectedValueOnce(Object.assign(new Error("no details"),{name:"TimeoutError"}))
        .mockResolvedValueOnce(ok([event()]));
      const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"gpt-test-reasoning"})(input);
      expect(result).toMatchObject({available:true,outcome:"found",partial:false});
      expect(fetch).toHaveBeenCalledTimes(2);
      const retry=JSON.parse(String(fetch.mock.calls[1][1].body));
      expect(retry.model).toBe("gpt-4.1-mini");
      expect(retry.text).toBeUndefined();
      expect(retry.max_output_tokens).toBe(SEARCH_MAX_OUTPUT_TOKENS);
      expect(info.mock.calls.map(c=>c[1])).toEqual([
        expect.objectContaining({attempt:1,parseFailure:"timeout"}),
        expect.objectContaining({attempt:2,parseFailure:null}),
      ]);
      expect(JSON.stringify(info.mock.calls)).not.toContain("Main St");
    }finally{info.mockRestore();}
  });

  it("stops after two timeouts, returning failed rather than no events",async()=>{
    const fetch=vi.fn().mockRejectedValue(Object.assign(new Error("connection"),{name:"TimeoutError"}));
    const run=createNearbyEventsSearch({fetch,apiKey:"k",model:"m"});
    expect(await run(input)).toEqual({available:false,outcome:"failed",reason:"timeout",category:"timeout"});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await run(input)).toMatchObject({available:false,outcome:"failed"});
    // Failed scans are never cached as a completed search.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([408,429,503])("retries transient HTTP %i once",async(status)=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response("retry",{status}))
      .mockResolvedValueOnce(ok([event()]));
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(result).toMatchObject({available:true,outcome:"found"});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry auth errors and never records them as no events",async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response("unauthorized",{status:401}));
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(result).toMatchObject({available:false,outcome:"failed",category:"http_error"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not accept a nonempty message on an incomplete Responses result",async()=>{
    const first={status:"incomplete",incomplete_details:{reason:"max_output_tokens"},
      output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({events:[event()]})}]}]};
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(first),{status:200}))
      .mockResolvedValueOnce(ok([]));
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})(input);
    expect(result).toEqual({available:true,outcome:"none_found",events:[],partial:false});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps all-incomplete scans failed and retries them on the next invocation",async()=>{
    const fixture={status:"incomplete",incomplete_details:{reason:"max_output_tokens"},
      output:[{type:"web_search_call",status:"completed"},{type:"reasoning",summary:[]}]};
    const fetch=vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture),{status:200}));
    const search=createNearbyEventsSearch({fetch,apiKey:"k",model:"m"});
    expect(await search(input)).toEqual({available:false,outcome:"failed",
      reason:"searchFailed",category:"incomplete"});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await search(input)).toMatchObject({available:false,outcome:"failed"});
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not call a partly failed, empty scan 'none found'",async()=>{
    const fetch=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)) as {input:string};
      return body.input.startsWith("Search specifically for Halloween")?
        new Response("offline",{status:503}):ok([]);
    });
    const result=await createNearbyEventsSearch({fetch,apiKey:"k",model:"m"})({
      ...input,countryCode:"US",to:"2026-10-31"});
    expect(result).toMatchObject({available:false,outcome:"failed",category:"http_error"});
  });

  it("caches an explicitly empty, fully successful search",async()=>{
    const fetch=vi.fn().mockResolvedValue(ok([]));
    const search=createNearbyEventsSearch({fetch,apiKey:"k",model:"m"});
    expect(await search(input)).toEqual({available:true,outcome:"none_found",events:[],partial:false});
    expect(await search(input)).toEqual({available:true,outcome:"none_found",events:[],partial:false});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call out without an API key",async()=>{
    const fetch=vi.fn();
    expect(await createNearbyEventsSearch({fetch,apiKey:"",model:"m"})(input)).toEqual({available:false,outcome:"failed",reason:"notConfigured",category:"not_configured"});
    expect(fetch).not.toHaveBeenCalled();
  });
});
