import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {cityScopeKey} from "@/lib/events/cityEventIdentity";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/cafeLocation.server",()=>({
  readPrimaryLocation:vi.fn(async()=>({
    city:"Sacramento",region:"CA",country_code:"US",
  })),
}));
import {readCityEventCatalog} from "./cafeEvents.server";

const date="2026-11-05";
const cityKey=cityScopeKey({city:"Sacramento",region:"CA",countryCode:"US"});
const uuid=(i:number)=>"00000000-0000-4000-8000-"+String(i).padStart(12,"0");
const target=uuid(511),legacy=uuid(999);
const events=Array.from({length:525},(_,i)=>({
  id:uuid(i),city_key:cityKey,name:"City event "+i,kind:"community",
  start_date:date,end_date:date,start_time:"10:00",end_time:"16:00",
  time_source_url:"https://city.example.org/calendar",
  venue:"Hall "+i,venue_address:i+" Main St",
  last_checked_at:"2026-11-03T09:00:00Z",
}));
const privateLinks=[{business_id:"cafe-a",city_event_id:target,cafe_event_id:legacy}];
const legacyRows=[{business_id:"cafe-a",id:legacy,status:"cancelled",
  last_verified_at:"2026-11-03T10:00:00Z"}];
function fakeDb(){
  const calls:Array<{table:string;field:string;value:unknown}>=[];
  const data:Record<string,Record<string,unknown>[]>={
    city_events:[...events,{
      ...events[0],id:uuid(800),city_key:"another-city",name:"Other city's private event",
    }],
    city_event_sources:[{city_event_id:target,
      source_url:"https://city.example.org/events/511",
      observed_at:"2026-11-03T09:00:00Z"}],
    cafe_city_event_links:privateLinks,
    cafe_events:legacyRows,
  };
  return {
    calls,
    db:{from(table:string){
      const filters:Array<(row:Record<string,unknown>)=>boolean>=[];
      const rows=()=>data[table].filter(row=>filters.every(test=>test(row)));
      const q={
        select:()=>q,
        eq:(field:string,value:unknown)=>{
          calls.push({table,field,value});
          filters.push(row=>row[field]===value);return q;
        },
        lte:(field:string,value:string)=>{
          filters.push(row=>String(row[field])<=value);return q;
        },
        gte:(field:string,value:string)=>{
          filters.push(row=>String(row[field])>=value);return q;
        },
        in:(field:string,ids:string[])=>{
          filters.push(row=>ids.includes(String(row[field])));return q;
        },
        ilike:()=>q,
        order:()=>q,
        range:async(from:number,to:number)=>({
          data:rows().slice(from,to+1),count:rows().length,error:null,
        }),
        limit:async(max:number)=>({data:rows().slice(0,max),error:null}),
        then:(resolve:(result:unknown)=>unknown,reject?:(error:unknown)=>unknown)=>
          Promise.resolve({data:rows(),error:null}).then(resolve,reject),
      };
      return q;
    }} as unknown as SupabaseClient,
  };
}
describe("LDI G exact-ID canonical city reading",()=>{
  it("does not lose the 512th same-date event among 525 and preserves its sourced status",async()=>{
    const {db,calls}=fakeDb();
    const first=await readCityEventCatalog(db,"cafe-a",date,date,
      {page:0,pageSize:25});
    expect(first.total).toBe(525);
    expect(first.items).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(first.items.some(e=>e.id===target)).toBe(false);
    const exact=await readCityEventCatalog(db,"cafe-a",date,date,
      {page:0,pageSize:1,cityEventId:target});
    expect(exact).toMatchObject({available:true,page:0,pageSize:1,total:1,
      hasMore:false,items:[{
        id:target,name:"City event 511",venue:"Hall 511",
        cafeEventId:legacy,status:"cancelled",
        lastVerifiedAt:"2026-11-03T10:00:00Z",
        sources:[{url:"https://city.example.org/events/511"}],
      }]});
    expect(calls).toContainEqual({table:"city_events",field:"id",value:target});
    expect(calls).toContainEqual({table:"cafe_city_event_links",
      field:"business_id",value:"cafe-a"});
  });
  it("shares only city facts: a second café does not receive the first café's link/status",async()=>{
    const {db}=fakeDb();
    const other=await readCityEventCatalog(db,"cafe-b",date,date,
      {page:0,pageSize:1,cityEventId:target});
    expect(other.items).toMatchObject([{
      id:target,name:"City event 511",cafeEventId:null,status:null,
      lastVerifiedAt:null,
    }]);
    expect(other.items[0].sources[0].url).toBe("https://city.example.org/events/511");
  });
  it("does not read another city's records even with the exact event ID",async()=>{
    const {db}=fakeDb();
    const other=await readCityEventCatalog(db,"cafe-a",date,date,
      {page:0,pageSize:1,cityEventId:uuid(800)});
    expect(other.total).toBe(0);
    expect(other.items).toEqual([]);
  });
});
