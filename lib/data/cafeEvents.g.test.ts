import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

vi.mock("./cafeLocation.server",()=>({
  readPrimaryLocation:vi.fn(async()=>({city:"Metro",region:"CA",country_code:"US"})),
}));
import {readCityEventCatalog} from "./cafeEvents.server";

const rows=Array.from({length:602},(_,index)=>({
  id:"city-"+String(index).padStart(4,"0"),
  name:index%10===0?"Grand Hall "+index:"City Event "+index,
  kind:index%10===0?"festival":"community",
  start_date:"2026-11-06",end_date:"2026-11-06",
  start_time:null,end_time:null,time_source_url:null,
  venue:index%10===0?"Grand Hall":"Civic Center",venue_address:null,
  last_checked_at:"2026-11-03T10:00:00Z",
}));

/** Fixture represents the same shared city catalog for two differently scoped cafés.
 * Query operators execute rather than returning a pre-selected first page. */
function fakeDb(options:{missingSchema?:boolean}={}){
  const visited:Array<{table:string;from:number;to:number;kind?:string;search?:string}>=[];
  const from=(table:string)=>{
    const equals=new Map<string,string>();
    const includes=new Map<string,string[]>();
    let pattern="";
    const records=()=>{
      if(table==="city_events"){
        if(options.missingSchema)return {data:null,count:null,error:{code:"42P01"}};
        const filtered=rows.filter(row=>
          (!equals.has("kind")||row.kind===equals.get("kind"))&&
          (!pattern||row.name.toLowerCase().includes(pattern.toLowerCase())));
        return {data:filtered,count:filtered.length,error:null};
      }
      if(table==="city_event_sources"){
        const ids=new Set(includes.get("city_event_id")??[]);
        return {data:rows.filter(row=>ids.has(row.id)).map(row=>({
          city_event_id:row.id,source_url:"https://events.example.org/"+row.id,
          observed_at:"2026-11-03T10:00:00Z",
        })),error:null};
      }
      if(table==="cafe_city_event_links"){
        const selected=equals.get("business_id")==="cafe-a"&&
          (includes.get("city_event_id")??[]).includes("city-0501");
        return {data:selected?[{city_event_id:"city-0501",cafe_event_id:"legacy-0501"}]:[],error:null};
      }
      if(table==="cafe_events"){
        const selected=equals.get("business_id")==="cafe-a"&&
          (includes.get("id")??[]).includes("legacy-0501");
        return {data:selected?[{id:"legacy-0501",status:"cancelled",
          last_verified_at:"2026-11-03T08:00:00Z"}]:[],error:null};
      }
      throw new Error("Unexpected table "+table);
    };
    const query={
      select:(_columns:string,_options?:unknown)=>query,
      eq:(key:string,value:string)=>{equals.set(key,value);return query;},
      lte:(_key:string,_value:string)=>query,
      gte:(_key:string,_value:string)=>query,
      in:(key:string,value:string[])=>{includes.set(key,value);return query;},
      ilike:(_key:string,value:string)=>{
        pattern=value.slice(1,-1).replace(/\\([%_\\])/g,"$1");return query;
      },
      order:(_key:string,_options?:unknown)=>query,
      limit:(_n:number)=>Promise.resolve(records()),
      range:(start:number,end:number)=>{
        const result=records();
        const base=result as {data:unknown[]|null;count?:number|null;error:unknown};
        visited.push({table,from:start,to:end,kind:equals.get("kind"),search:pattern||undefined});
        return Promise.resolve({...result,data:base.data?.slice(start,end+1)??null});
      },
      then:(resolve:(value:unknown)=>unknown,reject?:(reason:unknown)=>unknown)=>
        Promise.resolve(records()).then(resolve,reject),
    };
    return query;
  };
  return {db:{from} as unknown as SupabaseClient,visited};
}

describe("LDI G — canonical city paging and café-private source status",()=>{
  const from="2026-11-01",to="2026-11-30";
  it("returns event 501 on page 6 rather than silently stopping after 500, with source and private status",async()=>{
    const fixture=fakeDb();
    const page=await readCityEventCatalog(fixture.db,"cafe-a",from,to,{page:5,pageSize:100});
    expect(page).toMatchObject({available:true,total:602,page:5,pageSize:100,hasMore:true});
    expect(page.items).toHaveLength(100);
    expect(page.items[1]).toMatchObject({id:"city-0501",status:"cancelled",
      cafeEventId:"legacy-0501",lastVerifiedAt:"2026-11-03T08:00:00Z",
      sources:[{url:"https://events.example.org/city-0501"}]});
    expect(fixture.visited.filter(x=>x.table==="city_events")).toEqual([{
      table:"city_events",from:500,to:599,kind:undefined,search:undefined,
    }]);
    const last=await readCityEventCatalog(fixture.db,"cafe-a",from,to,{page:6,pageSize:100});
    expect(last).toMatchObject({total:602,hasMore:false});
    expect(last.items.map(item=>item.id)).toEqual(["city-0600","city-0601"]);
  });
  it("shows the identical public source but never another café's private status or link",async()=>{
    const fixture=fakeDb();
    const page=await readCityEventCatalog(fixture.db,"cafe-b",from,to,{page:5,pageSize:100});
    expect(page.items[1]).toMatchObject({id:"city-0501",cafeEventId:null,
      status:null,lastVerifiedAt:null,
      sources:[{url:"https://events.example.org/city-0501"}]});
  });
  it("applies literal name and kind filters before counting and paging",async()=>{
    const fixture=fakeDb();
    const first=await readCityEventCatalog(fixture.db,"cafe-a",from,to,
      {page:0,pageSize:25,kind:"festival",search:"Hall"});
    expect(first).toMatchObject({available:true,total:61,hasMore:true});
    expect(first.items).toHaveLength(25);
    expect(first.items.every(item=>item.kind==="festival"&&item.name.includes("Hall"))).toBe(true);
    const last=await readCityEventCatalog(fixture.db,"cafe-a",from,to,
      {page:2,pageSize:25,kind:"festival",search:"Hall"});
    expect(last.items).toHaveLength(11);
    expect(last.hasMore).toBe(false);
    expect(fixture.visited.at(-1)).toMatchObject({from:50,to:74,kind:"festival",search:"Hall"});
  });
  it("labels missing shared schema unavailable, rather than inventing a confirmed zero-event city",async()=>{
    const fixture=fakeDb({missingSchema:true});
    expect(await readCityEventCatalog(fixture.db,"cafe-a",from,to)).toMatchObject({
      available:false,missing:"migration_pending",total:0,hasMore:false,items:[],
    });
  });
});
