import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

const f=vi.hoisted(()=>({
  city:vi.fn(),neighborhood:vi.fn(),writeCity:vi.fn(),writeCoverage:vi.fn(),
  writeNeighborhood:vi.fn(),link:vi.fn(),readLocation:vi.fn(),
}));
vi.mock("./citySourceResearch.server",()=>({createCitySourceResearch:()=>f.city}));
vi.mock("./neighborhoodResearch.server",()=>({researchNeighborhood:f.neighborhood}));
vi.mock("./cityEventPersistence.server",()=>({
  upsertCityEventFact:f.writeCity,recordCitySourceCoverage:f.writeCoverage,
  upsertCafeNeighborhoodEvidence:f.writeNeighborhood,linkCityEventToCafeEvent:f.link,
}));
vi.mock("@/lib/data/cafeLocation.server",()=>({readPrimaryLocation:f.readLocation}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({
  readOwnerProposals:async()=>[],readOwnerReports:async()=>[],
}));

import {newLdiBudget,scanSharedResearch} from "./ldiIntegration.server";
import {readSavedEventTimeline,readCityEventCatalog} from "@/lib/data/cafeEvents.server";
import {eventScanWindows} from "./eventsLookahead";

// Dynamic Supabase query fixture deliberately models untyped table columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Tables=Record<string,Row[]>;
const cityId="11111111-1111-4111-8111-111111111111";
const placeId="22222222-2222-4222-8222-222222222222";
const cafeA="33333333-3333-4333-8333-333333333333";
const cafeB="44444444-4444-4444-8444-444444444444";
const location={label:"100 Main Street, Example, CA, US",city:"Example",region:"CA",
  countryCode:"US",postalCode:null,source:"profile" as const};
const stamp="2026-11-03T16:00:00Z";
function mockStore(){
  const tables:Tables=Object.fromEntries([
    "cafe_neighborhood_source_coverage","city_source_coverage","city_places",
    "city_events","city_event_sources","cafe_city_event_links",
    "cafe_events","cafe_neighborhood_evidence"].map(t=>[t,[]]));
  const db={
    from(table:string){
      if(!tables[table])throw Error("unexpected table "+table);
      const filters:Array<(row:Row)=>boolean>=[];
      const order:Array<{column:string;ascending:boolean}>=[];
      let start=0,size=Infinity,modification:Row|null=null;
      const q={
        select(_fields:string,_opts?:Row){return q;},
        eq(column:string,value:unknown){filters.push(r=>r[column]===value);return q;},
        lte(column:string,value:string){filters.push(r=>String(r[column])<=value);return q;},
        gte(column:string,value:string){filters.push(r=>String(r[column])>=value);return q;},
        in(column:string,values:string[]){filters.push(r=>values.includes(r[column]));return q;},
        not(column:string,_operator:string,value:unknown){
          filters.push(r=>r[column]!==value);return q;
        },
        order(column:string,opts:{ascending?:boolean}={}){
          order.push({column,ascending:opts.ascending??true});return q;
        },
        range(from:number,to:number){start=from;size=to-from+1;return q;},
        limit(n:number){size=n;return q;},
        update(row:Row){modification=row;return q;},
        async upsert(values:Row|Row[],opts:{onConflict:string;ignoreDuplicates?:boolean}){
          for(const row of Array.isArray(values)?values:[values]){
            const keys=opts.onConflict.split(",");
            const found=tables[table].find(v=>keys.every(k=>v[k]===row[k]));
            if(found){
              if(!opts.ignoreDuplicates)Object.assign(found,row);
            }else tables[table].push({...row,
              ...(table==="cafe_events"?{found_at:stamp}:{}),
            });
          }
          return {data:null,error:null};
        },
        then(ok:(v:{data:Row[];error:null;count:number})=>unknown,
          failed?:(e:unknown)=>unknown){
          const matches=tables[table].filter(r=>filters.every(fn=>fn(r)));
          if(modification)for(const row of matches)Object.assign(row,modification);
          const sorted=[...matches].sort((a,b)=>{
            for(const s of order){
              const d=String(a[s.column]).localeCompare(String(b[s.column]));
              if(d!==0)return s.ascending?d:-d;
            }return 0;
          });
          return Promise.resolve({data:sorted.slice(start,start+size),error:null,
            count:matches.length}).then(ok,failed);
        },
      };
      return q;
    },
  };
  f.readLocation.mockImplementation(async()=>({
    city:"Example",region:"CA",country_code:"US",name:"Example Café",
    address_line1:"100 Main Street",address_line2:null,postal_code:"90000",open_hours:null,
  }));
  f.writeCoverage.mockImplementation(async (_db:unknown,input:Row)=>{
    const row={city_key:"us|ca|example",source_key:input.sourceKey,
      window_from:input.from,window_to:input.to,status:input.status,
      last_checked_at:input.checkedAt,
      last_completed_at:["found","none_found"].includes(input.status)?input.checkedAt:null,
    };
    const existing=tables.city_source_coverage.find(r=>r.city_key===row.city_key&&
      r.source_key===row.source_key&&r.window_from===row.window_from&&
      r.window_to===row.window_to);
    if(existing){
      const complete=["found","none_found"].includes(input.status);
      Object.assign(existing,{...row,last_completed_at:complete?input.checkedAt:
        existing.last_completed_at});
    }else tables.city_source_coverage.push(row);
  });
  f.writeCity.mockImplementation(async (_db:unknown,input:Row)=>{
    let event=tables.city_events.find(e=>e.name===input.name&&
      e.start_date===input.startDate&&e.kind===input.kind);
    if(!event){
      event={id:cityId,city_key:"us|ca|example",name:input.name,kind:input.kind,
        start_date:input.startDate,end_date:input.startDate,
        venue:null,venue_address:null,last_checked_at:input.checkedAt};
      tables.city_events.push(event);
    }
    if(!tables.city_event_sources.some(s=>s.city_event_id===event.id&&
      s.source_url===input.sourceUrl))
      tables.city_event_sources.push({
        city_event_id:event.id,source_url:input.sourceUrl,observed_at:input.checkedAt,
      });
    return {cityEventId:event.id,cityKey:event.city_key,identityKey:"identity"};
  });
  f.writeNeighborhood.mockImplementation(async (_db:unknown,input:Row)=>{
    if(!tables.city_places.length)tables.city_places.push({
      id:placeId,identity_key:"a".repeat(64),city_key:"us|ca|example",
      name:input.name,kind:input.kind,address:input.address,
      source_url:input.sourceUrl,calendar_url:input.calendarUrl,
      last_checked_at:input.checkedAt,
    });
    const prior=tables.cafe_neighborhood_evidence.find(r=>
      r.business_id===input.businessId&&r.place_id===placeId);
    if(!prior)tables.cafe_neighborhood_evidence.push({
      business_id:input.businessId,place_id:placeId,assessment:input.assessment,
      rationale:input.rationale,checked_at:input.checkedAt,
    });
    return {placeId,cityKey:"us|ca|example"};
  });
  f.link.mockImplementation(async (_db:unknown,input:Row)=>{
    const exists=tables.cafe_city_event_links.some(r=>
      r.business_id===input.businessId&&r.city_event_id===input.cityEventId);
    if(!exists)tables.cafe_city_event_links.push({
      business_id:input.businessId,cafe_event_id:input.cafeEventId,
      city_event_id:input.cityEventId});
    return input.cafeEventId;
  });
  const scoped=async(businessId:string,today:string,
    window:{from:string;to:string;reason:"initial"|"weekly"|"new_day"},
    budget=newLdiBudget())=>scanSharedResearch(db as unknown as SupabaseClient,{
      businessId,location,today,window,budget,checkedAt:stamp,
    });
  return {db:db as unknown as SupabaseClient,tables,scoped};
}
function neighborhoodFixture(scopes:string[]){
  return {outcome:"found",checkedAt:stamp,researchedAddress:location.label,
    publicPlaces:[{placeKey:"hall",name:"Civic Hall",type:"convention",
      address:"20 Civic St",sourceUrl:"https://hall.example.org/about",
      calendarUrl:"https://hall.example.org/calendar",visitorInfoUrl:"https://hall.example.org/visit",
      visitorApproach:"Main entrance",visitorApproachSourceUrl:"https://hall.example.org/visit",
      entrance:null,entranceSourceUrl:null,sourceStatus:"cited_public_page",
      checkedAt:stamp,visitorCount:null,routeDistanceMeters:null,
      actualCafeDemand:null,unknowns:["visitor_count","route_distance","actual_cafe_demand"]}],
    cafeHypotheses:[{placeKey:"hall",kind:"hypothesis",possibleConnection:"Possible visitors",
      placeSourceUrl:"https://hall.example.org/about",observedImpact:null,
      projectedSalesLift:null}],
    coverage:scopes.map(scope=>({scope,categories:[],
      outcome:"found",checkedAt:stamp,placesFound:1,discardedCandidates:0,
      retryEligible:false,failure:null})),unknowns:[],error:null};
}
beforeEach(()=>{
  vi.clearAllMocks();
  f.neighborhood.mockImplementation(async ({scopes}:{scopes:string[]})=>
    neighborhoodFixture(scopes));
  f.city.mockImplementation(async ({sources,window}:{
    sources:Array<{id:string;kind:string}>;window:{from:string;to:string;reason:string}})=>{
    const source=sources[0];
    const events=source.kind==="city_calendar"&&
      window.from<="2026-11-04"&&window.to>="2026-11-04"?
      [{name:"Neighborhood fair",startDate:"2026-11-04",
        sourceUrl:"https://city.example.org/fair"}]:[];
    return {events,sources:[{sourceId:source.id,sourceKind:source.kind,
      officialUrl:null,from:window.from,to:window.to,reason:window.reason,
      checkedAt:stamp,outcome:events.length?"found":"none_found",
      retryEligible:false,failure:null,events}],duplicateCount:0,
      partial:false,retrySourceIds:[]};
  });
});
describe("LDI E scheduled B+C→A→single Events reader",()=>{
  it("persists the initial 14 days, auto-researched official calendar and shared city facts",async()=>{
    const s=mockStore(),budget=newLdiBudget();budget.cityTasks=40;
    const window=eventScanWindows("2026-11-03",null,"address")[0];
    const result=await s.scoped(cafeA,"2026-11-03",window,budget);
    expect(result?.completed).toBe(true);
    expect(f.neighborhood).toHaveBeenCalledWith(expect.objectContaining({
      address:expect.objectContaining({label:location.label}),
    }));
    expect(f.city).toHaveBeenCalledWith(expect.objectContaining({
      sources:[expect.objectContaining({kind:"venue",
        officialUrl:"https://hall.example.org/calendar"})],
    }));
    expect(f.writeCity).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({name:"Neighborhood fair",kind:"other"}));
    expect(s.tables.city_source_coverage.filter(r=>r.status!=="partial")).toHaveLength(16);
    expect(s.tables.city_places[0]).toMatchObject({visitor_info_url:"https://hall.example.org/visit"});
    const timeline=await readSavedEventTimeline(s.db,
      {businessId:cafeA,ownerUserId:"owner-a"},"2026-11-03","2026-11-16");
    expect(timeline.cityCatalog?.items).toHaveLength(1);
    expect(timeline.cityCatalog?.items[0]).toMatchObject({
      name:"Neighborhood fair",venue:null,cafeEventId:timeline.events[0].id});
    expect(timeline.events[0].cityEventId).toBe(cityId);
    expect(timeline.neighborhood?.[0]).toMatchObject({
      assessment:"potential",rationale:"Possible visitors"});
    expect(timeline.cityCatalog?.items[0].sources[0].url).toBe("https://city.example.org/fair");
  });
  it("uses one city search for two cafés but keeps private hypotheses isolated",async()=>{
    const s=mockStore();
    const budget=newLdiBudget();budget.cityTasks=40;budget.neighborhoodScopes=8;
    const window=eventScanWindows("2026-11-03",null,"address")[0];
    await s.scoped(cafeA,"2026-11-03",window,budget);
    const searches=f.city.mock.calls.length;
    await s.scoped(cafeB,"2026-11-03",window,budget);
    expect(f.city).toHaveBeenCalledTimes(searches);
    expect(s.tables.city_events).toHaveLength(1);
    expect(s.tables.cafe_city_event_links).toHaveLength(2);
    expect(s.tables.cafe_city_event_links[0].cafe_event_id)
      .not.toBe(s.tables.cafe_city_event_links[1].cafe_event_id);
    expect(s.tables.cafe_neighborhood_evidence.map(r=>r.business_id).sort())
      .toEqual([cafeA,cafeB].sort());
  });
  it("never marks an incomplete city source window complete; retries only incomplete work",async()=>{
    const s=mockStore(),budget=newLdiBudget();budget.cityTasks=40;
    const original=f.city.getMockImplementation();
    let failed=false;
    f.city.mockImplementation(async(input:Row)=>{
      if(!failed){failed=true;return {
        events:[],sources:[{sourceId:input.sources[0].id,sourceKind:input.sources[0].kind,
          officialUrl:null,from:input.window.from,to:input.window.to,
          reason:input.window.reason,checkedAt:stamp,outcome:"failed",
          retryEligible:true,failure:"timeout",events:[]}],
        duplicateCount:0,partial:true,retrySourceIds:[input.sources[0].id]};
      }
      return original!(input);
    });
    const window=eventScanWindows("2026-11-03",null,"address")[0];
    const first=await s.scoped(cafeA,"2026-11-03",window,budget);
    expect(first?.completed).toBe(false);
    expect(s.tables.city_source_coverage.some(r=>r.status==="failed")).toBe(true);
    const count=f.city.mock.calls.length;
    const second=await s.scoped(cafeA,"2026-11-03",window,{
      ...newLdiBudget(),cityTasks:40});
    expect(second?.completed).toBe(true);
    expect(f.city.mock.calls.length-count).toBe(1);
  });
  it("adds exactly the new day, and does a separate Monday rediscovery without dropping IDs",async()=>{
    const s=mockStore(),budget={...newLdiBudget(),cityTasks:40};
    const initial=eventScanWindows("2026-11-03",null,"hash")[0];
    const first=await s.scoped(cafeA,"2026-11-03",initial,budget);
    expect(first?.completed).toBe(true);
    const daily=eventScanWindows("2026-11-04",{
      locationHash:"hash",scannedThroughDate:"2026-11-16",weeklyResearchedOn:null},"hash");
    expect(daily).toEqual([{from:"2026-11-17",to:"2026-11-17",reason:"new_day"}]);
    const before=f.city.mock.calls.length;
    await s.scoped(cafeA,"2026-11-04",daily[0],{
      ...newLdiBudget(),cityTasks:40});
    expect(f.city.mock.calls.slice(before).every(([x])=>x.window.from==="2026-11-17"))
      .toBe(true);
    const weekly=eventScanWindows("2026-11-09",{
      locationHash:"hash",scannedThroughDate:"2026-11-17",weeklyResearchedOn:null},"hash");
    expect(weekly).toEqual([{from:"2026-11-09",to:"2026-11-22",reason:"weekly"}]);
    await s.scoped(cafeA,"2026-11-09",weekly[0],{
      ...newLdiBudget(),cityTasks:40});
    expect(s.tables.city_events).toHaveLength(1);
  });
  it("pages an owner catalog past old 500-row caps; source URLs and null venues remain",async()=>{
    const s=mockStore();
    for(let i=0;i<540;i++)s.tables.city_events.push({
      id:String(i).padStart(36,"0"),city_key:"us|ca|example",name:"Public event "+i,
      kind:"other",start_date:"2026-11-04",end_date:"2026-11-04",
      venue:null,venue_address:null,last_checked_at:stamp,
    });
    const p=await readCityEventCatalog(s.db,cafeA,"2026-11-03","2026-11-16",
      {page:5,pageSize:100});
    expect(p).toMatchObject({available:true,total:540,page:5,hasMore:false});
    expect(p.items).toHaveLength(40);
    expect(p.items[0].venue).toBeNull();
  });
});
