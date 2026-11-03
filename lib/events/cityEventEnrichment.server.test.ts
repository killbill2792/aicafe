import {describe,expect,it,vi} from "vitest";
import {createCityEventEnrichment,EVENT_ENRICHMENT_MAX_OUTPUT_TOKENS}
  from "./cityEventEnrichment.server";

const candidate={city:"Example",region:"CA",countryCode:"US",
  name:"Civic Fair",startDate:"2026-11-04",
  sourceUrl:"https://city.example.org/events/civic-fair"};
const details={
  name:"Civic Fair",startDate:"2026-11-04",endDate:"2026-11-06",
  venue:"Civic Hall",venueAddress:"20 Civic St",startTime:"10:00",endTime:"18:00",
  evidenceUrl:candidate.sourceUrl,
};
function response(value:unknown,{searched=true,cited=true}={}){
  return {ok:true,status:200,json:async()=>({
    status:"completed",
    output:[...(searched?[{type:"web_search_call",status:"completed",
      action:{sources:cited?[{url:candidate.sourceUrl}]:[]}}]:[]),
      {type:"message",content:[{type:"output_text",text:JSON.stringify(value)}]}],
  })} as unknown as Response;
}
describe("bounded source-backed optional enrichment",()=>{
  it("saves only information supported by completed web search of the dated source",async()=>{
    const request=vi.fn(async()=>response(details));
    const enrich=createCityEventEnrichment({apiKey:"test",fetch:request as typeof fetch});
    expect(await enrich(candidate)).toEqual({
      venue:"Civic Hall",venueAddress:"20 Civic St",
      startTime:"10:00",endTime:"18:00",endDate:"2026-11-06",
      evidenceUrl:candidate.sourceUrl,
    });
    const payload=JSON.parse(String(request.mock.calls[0][1]?.body)) as {
      max_output_tokens:number;tools:unknown[];input:string};
    expect(payload.max_output_tokens).toBe(EVENT_ENRICHMENT_MAX_OUTPUT_TOKENS);
    expect(payload.tools).toHaveLength(1);
    expect(payload.input).toContain("null for every unconfirmed field");
  });
  it("refuses an AI JSON response if no completed web search or page citation exists",async()=>{
    for(const meta of [{searched:false,cited:true},{searched:true,cited:false}]){
      const request=vi.fn(async()=>response(details,meta));
      expect(await createCityEventEnrichment({apiKey:"test",fetch:request as typeof fetch})
        (candidate)).toBeNull();
    }
  });
  it("rejects wrong event identity, uncited alternate source and invented duration or hours",async()=>{
    const invalid=[
      {...details,name:"Different fair"},
      {...details,evidenceUrl:"https://city.example.org/events/other"},
      {...details,endDate:"2026-12-01"},
      {...details,startTime:"25:12"},
    ];
    for(const v of invalid){
      const request=vi.fn(async()=>response(v));
      expect(await createCityEventEnrichment({apiKey:"test",fetch:request as typeof fetch})
        (candidate)).toBeNull();
    }
  });
  it("does not invent fields when a complete cited source lacks details",async()=>{
    const request=vi.fn(async()=>response({...details,venue:null,venueAddress:null,
      endDate:null,startTime:null,endTime:null}));
    expect(await createCityEventEnrichment({apiKey:"test",fetch:request as typeof fetch})
      (candidate)).toBeNull();
  });
});
