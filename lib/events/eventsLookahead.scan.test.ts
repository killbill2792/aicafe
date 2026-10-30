import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

const search=vi.hoisted(()=>vi.fn());
vi.mock("./nearbyEventsSearch.server",()=>({searchNearbyEvents:search}));
vi.mock("@/lib/ownerFacts/store.server",()=>({loadOwnerFacts:vi.fn().mockResolvedValue([])}));
vi.mock("@/lib/data/cafeLocation.server",()=>({readCafeLocation:vi.fn().mockResolvedValue({
  label:"1 Main St, Example, US",city:"Example",region:"CA",countryCode:"US",
})}));
vi.mock("./holidays",async importOriginal=>{
  const actual=await importOriginal<typeof import("./holidays")>();
  return {...actual,holidaysBetween:()=>[]};
});
import {scanCafe} from "./eventsLookahead.server";

const business={id:"cafe-a",timezone:"America/Los_Angeles",is_demo:false};
const one={name:"Neighborhood market",startDate:"2026-11-04",endDate:"2026-11-04",
  kind:"community",venue:"Square",sourceUrl:"https://example.org/market"};
function fixture(){
  let state:Record<string,unknown>|null=null;
  const events=new Map<string,Record<string,unknown>>();
  const writes:Array<{table:string;options:Record<string,unknown>}>=[],requests:string[]=[];
  const db={
    from(table:string){
      if(table==="cafe_event_search_state")return {
        select:()=>({eq:()=>({maybeSingle:async()=>({data:state,error:null})})}),
        upsert:async(row:Record<string,unknown>,options:Record<string,unknown>)=>{
          state=row;writes.push({table,options});return {error:null};
        },
      };
      if(table==="cafe_events")return {
        upsert:async(rows:Record<string,unknown>[],options:Record<string,unknown>)=>{
          writes.push({table,options});
          for(const row of rows){
            const id=String(row.id);
            if(options.ignoreDuplicates&&!events.has(id))events.set(id,row);
            else if(!options.ignoreDuplicates)events.set(id,row);
          }
          return {error:null};
        },
      };
      throw Error("Unexpected table "+table);
    },
  } as unknown as SupabaseClient;
  search.mockImplementation(async(input:{from:string;to:string})=>{
    requests.push(input.from+".."+input.to);
    return {available:true,outcome:"none_found",events:[],partial:false};
  });
  return {db,events,writes,requests,getState:()=>state};
}
describe("cron-only discovery and preservation",()=>{
  beforeEach(()=>search.mockReset());
  it("scans all 14 days on first Tuesday, records even an empty successful search, then one day only",async()=>{
    const f=fixture();
    await scanCafe(f.db,business,"2026-11-03");
    expect(f.requests).toEqual(["2026-11-03..2026-11-16"]);
    expect(f.getState()).toMatchObject({scanned_through_date:"2026-11-16"});
    await scanCafe(f.db,business,"2026-11-03");
    expect(f.requests).toHaveLength(1);
    await scanCafe(f.db,business,"2026-11-04");
    expect(f.requests).toEqual(["2026-11-03..2026-11-16","2026-11-17..2026-11-17"]);
  });
  it("weekly research adds newly announced events without replacing old facts or status",async()=>{
    const f=fixture();
    search.mockImplementationOnce(async()=>({available:true,outcome:"found",events:[one],partial:false}));
    await scanCafe(f.db,business,"2026-11-03");
    const row=[...f.events.values()][0],id=String(row.id);
    f.events.set(id,{...row,status:"cancelled",venue:"Owner-confirmed venue"});
    search.mockImplementationOnce(async()=>({available:true,outcome:"found",
      events:[{...one,venue:"Provider changed venue"},
        {...one,name:"Newly announced market",sourceUrl:"https://example.org/new"}],
      partial:false}));
    await scanCafe(f.db,business,"2026-11-09");
    expect(f.requests).toEqual(["2026-11-03..2026-11-16","2026-11-09..2026-11-22"]);
    expect(f.events.get(id)).toMatchObject({status:"cancelled",venue:"Owner-confirmed venue"});
    expect(f.events.size).toBe(2);
    expect(f.writes.filter(w=>w.table==="cafe_events").every(w=>w.options.ignoreDuplicates===true)).toBe(true);
    await scanCafe(f.db,business,"2026-11-09");
    expect(f.requests).toHaveLength(2);
  });
  it("never advances the scan cursor for a failed or partial search",async()=>{
    const f=fixture();
    search.mockResolvedValueOnce({available:false,outcome:"failed",reason:"searchFailed"});
    await scanCafe(f.db,business,"2026-11-05");
    expect(f.getState()).toBeNull();
    search.mockResolvedValueOnce({available:true,outcome:"found",events:[one],partial:true});
    await scanCafe(f.db,business,"2026-11-05");
    expect(f.getState()).toBeNull();
    await scanCafe(f.db,business,"2026-11-05");
    expect(f.getState()).toMatchObject({scanned_through_date:"2026-11-18"});
    expect(f.requests).toHaveLength(3);
  });
});
