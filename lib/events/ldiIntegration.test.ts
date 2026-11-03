import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

const f=vi.hoisted(()=>({
  city:vi.fn(),neighborhood:vi.fn(),writeCity:vi.fn(),writeCoverage:vi.fn(),
  writeNeighborhood:vi.fn(),link:vi.fn(),readLocation:vi.fn(),
  enrichment:vi.fn(),
}));
vi.mock("./citySourceResearch.server",()=>({createCitySourceResearch:()=>f.city}));
vi.mock("./neighborhoodResearch.server",()=>({researchNeighborhood:f.neighborhood}));
vi.mock("./cityEventEnrichment.server",()=>({enrichCityEventFact:f.enrichment}));
vi.mock("./cityEventPersistence.server",()=>({
  upsertCityEventFact:f.writeCity,recordCitySourceCoverage:f.writeCoverage,
  upsertCafeNeighborhoodEvidence:f.writeNeighborhood,linkCityEventToCafeEvent:f.link,
}));
vi.mock("@/lib/data/cafeLocation.server",()=>({readPrimaryLocation:f.readLocation}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({
  readOwnerProposals:async()=>[],readOwnerReports:async()=>[],
}));

import {newLdiBudget,scanSharedResearch,planCityResearchJobs,
  reconciledCityRootStatus} from "./ldiIntegration.server";
import {readCafeEvents,readSavedEventTimeline,readCityEventCatalog,
  readCityResearchCoverage} from "@/lib/data/cafeEvents.server";
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
  // Emulate A's source identity / corroborated venue-address aliasing instead
  // of incorrectly collapsing every same-name/date listing into one city row.
  f.writeCity.mockImplementation(async (_db:unknown,input:Row)=>{
    const source=tables.city_event_sources.find(s=>s.source_url===input.sourceUrl&&
      tables.city_events.some(e=>e.id===s.city_event_id&&
        e.start_date===input.startDate&&e.name===input.name));
    let event=source?tables.city_events.find(e=>e.id===source.city_event_id):undefined;
    if(!event&&input.venue&&input.venueAddress)
      event=tables.city_events.find(e=>e.name===input.name&&
        e.start_date===input.startDate&&e.venue===input.venue&&
        e.venue_address===input.venueAddress);
    if(!event){
      const id=tables.city_events.length===0?cityId:
        "55555555-5555-4555-8555-"+String(tables.city_events.length)
          .padStart(12,"0");
      event={id,city_key:"us|ca|example",name:input.name,kind:input.kind,
        start_date:input.startDate,end_date:input.endDate??input.startDate,
        start_time:null,end_time:null,time_source_url:null,
        venue:input.venue??null,venue_address:input.venueAddress??null,
        last_checked_at:input.checkedAt};
      tables.city_events.push(event);
    }else{
      event.venue??=input.venue??null;
      event.venue_address??=input.venueAddress??null;
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
  f.enrichment.mockResolvedValue(null);
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
  it("retains optional cited venue, duration and hours without changing B's discovery format",async()=>{
    const s=mockStore();
    f.enrichment.mockResolvedValueOnce({endDate:"2026-11-06",venue:"Civic Hall",
      venueAddress:"20 Civic St",startTime:"09:00",endTime:"17:00",
      evidenceUrl:"https://city.example.org/fair"});
    await s.scoped(cafeA,"2026-11-03",
      eventScanWindows("2026-11-03",null,"hash")[0],
      {...newLdiBudget(),cityTasks:40});
    expect(s.tables.city_events[0]).toMatchObject({
      venue:"Civic Hall",venue_address:"20 Civic St",end_date:"2026-11-06",
      start_time:"09:00",end_time:"17:00",
      time_source_url:"https://city.example.org/fair",
    });
    const page=await readCityEventCatalog(s.db,cafeA,"2026-11-03","2026-11-16");
    expect(page.items[0]).toMatchObject({
      endDate:"2026-11-06",startTime:"09:00",endTime:"17:00"});
    expect(f.city.mock.calls[0][0].sources).toHaveLength(1);
  });
  it("extends a previously discovered one-day city fact only with cited HTTPS end-date provenance",async()=>{
    const s=mockStore();
    const window=eventScanWindows("2026-11-03",null,"location")[0];
    const generous=()=>({...newLdiBudget(),cityTasks:40});
    // B first discovers a single date, with no second-pass evidence.
    await s.scoped(cafeA,"2026-11-03",window,generous());
    expect(s.tables.city_events).toHaveLength(1);
    expect(s.tables.city_events[0].end_date).toBe("2026-11-04");
    // Later rediscovery of the SAME fact obtains a cited multi-day end date.
    f.enrichment.mockResolvedValue({endDate:"2026-11-07",venue:null,
      venueAddress:null,startTime:null,endTime:null,
      evidenceUrl:"https://city.example.org/fair"});
    await s.scoped(cafeA,"2026-11-04",{
      from:"2026-11-04",to:"2026-11-04",reason:"new_day",
    },generous());
    expect(s.tables.city_events).toHaveLength(1);
    expect(s.tables.city_events[0]).toMatchObject({
      end_date:"2026-11-07",
      duration_source_url:"https://city.example.org/fair",
    });
    // A later null/shorter discovery cannot erase the extended public range.
    f.enrichment.mockResolvedValue({endDate:"2026-11-05",venue:null,
      venueAddress:null,startTime:null,endTime:null,
      evidenceUrl:"https://city.example.org/fair"});
    await s.scoped(cafeA,"2026-11-09",{
      from:"2026-11-04",to:"2026-11-17",reason:"weekly",
    },generous());
    expect(s.tables.city_events[0].end_date).toBe("2026-11-07");
    const catalog=await readCityEventCatalog(s.db,cafeA,"2026-11-06","2026-11-06");
    expect(catalog.items).toMatchObject([{
      id:cityId,endDate:"2026-11-07",
    }]);
  });

  it("never creates duplicate café plans for uncorroborated same-date titles from distinct URLs",async()=>{
    const s=mockStore();
    f.city.mockImplementation(async ({sources,window}:Row)=>{
      const source=sources[0];
      const event=source.kind==="city_calendar"||source.kind==="venue"?
        {name:"Civic Fair",startDate:"2026-11-04",
          sourceUrl:source.kind==="venue"?
            "https://hall.example.org/calendar/civic-fair":
            "https://city.example.org/events/civic-fair"}:null;
      const events=event&&window.from<="2026-11-04"&&window.to>="2026-11-04"?
        [event]:[];
      return {events,sources:[{sourceId:source.id,sourceKind:source.kind,
        officialUrl:source.officialUrl??null,from:window.from,to:window.to,
        reason:window.reason,checkedAt:stamp,
        outcome:events.length?"found":"none_found",retryEligible:false,
        failure:null,events}],duplicateCount:0,partial:false,retrySourceIds:[]};
    });
    await s.scoped(cafeA,"2026-11-03",
      eventScanWindows("2026-11-03",null,"address")[0],
      {...newLdiBudget(),cityTasks:40});
    expect(s.tables.city_events).toHaveLength(2);
    expect(s.tables.cafe_city_event_links).toHaveLength(0);
    expect(s.tables.cafe_events).toHaveLength(0);
    const page=await readCityEventCatalog(s.db,cafeA,"2026-11-03","2026-11-16");
    expect(page.items).toHaveLength(2);
    expect(page.items.every(e=>e.venue===null)).toBe(true);
    expect(page.items.map(e=>e.sources[0].url).sort()).toEqual([
      "https://city.example.org/events/civic-fair",
      "https://hall.example.org/calendar/civic-fair",
    ]);
  });
  it("reconciles distinct URLs only after matching cited venue and address",async()=>{
    const s=mockStore();
    f.city.mockImplementation(async ({sources,window}:Row)=>{
      const source=sources[0];
      const event=source.kind==="city_calendar"||source.kind==="venue"?
        {name:"Civic Fair",startDate:"2026-11-04",
          sourceUrl:source.kind==="venue"?
            "https://hall.example.org/calendar/civic-fair":
            "https://city.example.org/events/civic-fair"}:null;
      const events=event&&window.from<="2026-11-04"&&window.to>="2026-11-04"?
        [event]:[];
      return {events,sources:[{sourceId:source.id,sourceKind:source.kind,
        officialUrl:source.officialUrl??null,from:window.from,to:window.to,
        reason:window.reason,checkedAt:stamp,
        outcome:events.length?"found":"none_found",retryEligible:false,
        failure:null,events}],duplicateCount:0,partial:false,retrySourceIds:[]};
    });
    f.enrichment.mockImplementation(async (event:Row)=>({
      endDate:null,venue:"Civic Hall",venueAddress:"20 Civic St",
      startTime:null,endTime:null,evidenceUrl:event.sourceUrl,
    }));
    await s.scoped(cafeA,"2026-11-03",
      eventScanWindows("2026-11-03",null,"address")[0],
      {...newLdiBudget(),cityTasks:40});
    expect(s.tables.city_events).toHaveLength(1);
    expect(s.tables.city_event_sources).toHaveLength(2);
    expect(s.tables.cafe_city_event_links).toHaveLength(1);
  });
  it("keeps the Monday refresh epoch stable when Tuesday resumes incomplete work",async()=>{
    const s=mockStore();
    vi.useFakeTimers();
    try{
      vi.setSystemTime(new Date("2026-11-03T16:00:00Z"));
      const initial=eventScanWindows("2026-11-03",null,"location")[0];
      await s.scoped(cafeA,"2026-11-03",initial,{
        ...newLdiBudget(),cityTasks:40});
      vi.setSystemTime(new Date("2026-11-09T16:00:00Z"));
      const week={from:"2026-11-09",to:"2026-11-22",reason:"weekly" as const};
      expect((await s.scoped(cafeA,"2026-11-09",week,{
        ...newLdiBudget(),cityTasks:4}))?.completed).toBe(false);
      const mondaySuccess=s.tables.city_source_coverage.filter(r=>
        r.scan_from==="2026-11-09"&&r.is_scan_root&&
        ["found","none_found"].includes(r.status)).length;
      expect(mondaySuccess).toBe(4);
      vi.setSystemTime(new Date("2026-11-10T16:00:00Z"));
      await s.scoped(cafeA,"2026-11-10",
        {from:"2026-11-23",to:"2026-11-23",reason:"new_day"},{
          ...newLdiBudget(),cityTasks:4});
      const after=s.tables.city_source_coverage.filter(r=>
        r.scan_from==="2026-11-09"&&r.is_scan_root&&
        ["found","none_found"].includes(r.status)).length;
      expect(after).toBe(8);
    }finally{vi.useRealTimers();}
  });
  it("persists each entering day while a fourteen-day initial window is still retrying",async()=>{
    const s=mockStore();
    const first=eventScanWindows("2026-11-03",null,"address")[0];
    const low=()=>({...newLdiBudget(),cityTasks:4});
    expect((await s.scoped(cafeA,"2026-11-03",first,low()))?.completed)
      .toBe(false);
    await s.scoped(cafeA,"2026-11-04",
      eventScanWindows("2026-11-04",null,"address")[0],low());
    await s.scoped(cafeA,"2026-11-05",
      eventScanWindows("2026-11-05",null,"address")[0],low());
    for(const date of ["2026-11-17","2026-11-18"]){
      expect(s.tables.city_source_coverage.some(row=>
        row.window_from===date&&row.window_to===date&&
        row.is_scan_root&&!row.search_attempted)).toBe(true);
    }
    expect(s.tables.city_source_coverage.some(row=>row.scan_from==="2026-11-03"&&
      row.status==="partial")).toBe(true);
  });
  it("uses A's exact name canonicalization when matching legacy cancelled event UUIDs",async()=>{
    const s=mockStore();
    const legacyId="66666666-6666-4666-8666-666666666666";
    const sourceUrl="https://city.example.org/events/cafe-jazz?utm_source=calendar";
    s.tables.cafe_events.push({id:legacyId,business_id:cafeA,
      name:"Café & Jazz",kind:"conference",start_date:"2026-11-04",
      end_date:"2026-11-06",status:"cancelled",found_at:stamp,
      source_url:"https://city.example.org/events/cafe-jazz",
      last_checked_at:stamp});
    f.city.mockImplementation(async ({sources,window}:Row)=>{
      const source=sources[0];
      const events=source.kind==="city_calendar"&&
        window.from<="2026-11-04"&&window.to>="2026-11-04"?
        [{name:"Cafe and Jazz",startDate:"2026-11-04",sourceUrl}]:[];
      return {events,sources:[{sourceId:source.id,sourceKind:source.kind,
        officialUrl:source.officialUrl??null,from:window.from,to:window.to,
        reason:window.reason,checkedAt:stamp,
        outcome:events.length?"found":"none_found",retryEligible:false,
        failure:null,events}],duplicateCount:0,partial:false,retrySourceIds:[]};
    });
    const window=eventScanWindows("2026-11-03",null,"location")[0];
    const budget={...newLdiBudget(),cityTasks:40};
    await s.scoped(cafeA,"2026-11-03",window,budget);
    expect(s.tables.cafe_events).toHaveLength(1);
    expect(s.tables.cafe_events[0]).toMatchObject({
      id:legacyId,name:"Café & Jazz",status:"cancelled",end_date:"2026-11-06"});
    expect(s.tables.cafe_city_event_links).toEqual([expect.objectContaining({
      business_id:cafeA,cafe_event_id:legacyId,city_event_id:cityId})]);
    // A second café sees the same shared fact but does not acquire café A's
    // private cancellation, approval thread, or legacy UUID.
    await s.scoped(cafeB,"2026-11-03",window,{...newLdiBudget(),cityTasks:40});
    expect(s.tables.cafe_events.find(r=>r.business_id===cafeA)).toMatchObject({
      id:legacyId,status:"cancelled"});
    expect(s.tables.cafe_city_event_links[1].cafe_event_id).not.toBe(legacyId);
    const timeline=await readSavedEventTimeline(s.db,
      {businessId:cafeA,ownerUserId:"owner-a"},"2026-11-04","2026-11-06");
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]).toMatchObject({
      id:legacyId,status:"cancelled",endDate:"2026-11-06"});
  });

  it("batches consecutive pending daily dates per source without increasing six-call budget",async()=>{
    const s=mockStore();
    const initial=eventScanWindows("2026-11-03",null,"location")[0];
    expect((await s.scoped(cafeA,"2026-11-03",initial,
      {...newLdiBudget(),cityTasks:40}))?.completed).toBe(true);
    let didBatch=false;
    const dailyBacklog:number[]=[];
    for(let i=0;i<8;i++){
      const from=new Date(Date.UTC(2026,10,17+i)).toISOString().slice(0,10);
      const before=f.city.mock.calls.length;
      const scanned=await s.scoped(cafeA,"2026-11-"+String(4+i).padStart(2,"0"),
        {from,to:from,reason:"new_day"},{...newLdiBudget()});
      const now=f.city.mock.calls.slice(before);
      expect(now.length).toBeLessThanOrEqual(6);
      if(now.some(([args])=>args.window.from<args.window.to))didBatch=true;
      expect(scanned).not.toBeNull();
      const pending=s.tables.city_source_coverage.filter(r=>
        r.is_scan_root&&r.window_from<=from&&r.window_from>="2026-11-17"&&
        !["found","none_found"].includes(r.status));
      dailyBacklog.push(pending.length);
      // Eight sources (7 category + 1 official venue) against six calls/day:
      // exactly two current-day roots remain, never an accumulating backlog.
      expect(pending.every(r=>r.window_from===from)).toBe(true);
    }
    expect(dailyBacklog).toEqual(Array(8).fill(2));
    expect(didBatch).toBe(true);
    expect(s.tables.city_source_coverage.filter(r=>r.is_scan_root&&
      r.window_from>="2026-11-17"&&r.window_from<="2026-11-23"&&
      ["found","none_found"].includes(r.status))).toHaveLength(8*7);
  });

  it("keeps every affected day retryable if a combined B research call is partial",async()=>{
    const s=mockStore();
    const initial=eventScanWindows("2026-11-03",null,"location")[0];
    await s.scoped(cafeA,"2026-11-03",initial,{...newLdiBudget(),cityTasks:40});
    await s.scoped(cafeA,"2026-11-04",
      {from:"2026-11-17",to:"2026-11-17",reason:"new_day"},{...newLdiBudget()});
    const original=f.city.getMockImplementation();
    let failed=false;
    f.city.mockImplementation(async(input:Row)=>{
      if(input.window.from<input.window.to&&!failed){
        failed=true;
        const source=input.sources[0];
        return {events:[],sources:[{sourceId:source.id,sourceKind:source.kind,
          officialUrl:source.officialUrl??null,from:input.window.from,to:input.window.to,
          reason:input.window.reason,checkedAt:stamp,outcome:"partial",
          retryEligible:true,failure:"incomplete",events:[]}],
          duplicateCount:0,partial:true,retrySourceIds:[source.id]};
      }
      return original!(input);
    });
    await s.scoped(cafeA,"2026-11-05",
      {from:"2026-11-18",to:"2026-11-18",reason:"new_day"},{...newLdiBudget()});
    const unresolved=s.tables.city_source_coverage.filter(r=>r.is_scan_root&&
      r.window_from==="2026-11-17"&&r.status==="partial");
    expect(unresolved).toHaveLength(1);
    const source=unresolved[0].source_key;
    expect(s.tables.city_source_coverage.find(r=>
      r.is_scan_root&&r.window_from==="2026-11-18"&&r.source_key===source)?.status)
      .toBe("partial");
    await s.scoped(cafeA,"2026-11-06",
      {from:"2026-11-19",to:"2026-11-19",reason:"new_day"},{...newLdiBudget()});
    expect(s.tables.city_source_coverage.filter(r=>r.is_scan_root&&
      r.source_key===source&&r.window_from==="2026-11-17")[0].status)
      .toBe("none_found");
    // The failed combined search can leave a PARTIAL diagnostic child row,
    // but never a false PARTIAL owner-facing city summary after root retries.
    await s.scoped(cafeA,"2026-11-06",
      {from:"2026-11-19",to:"2026-11-19",reason:"new_day"},{
        ...newLdiBudget(),cityTasks:40});
    const summary=await readCityResearchCoverage(s.db,cafeA,"2026-11-17","2026-11-19");
    expect(summary.status).toBe("complete");
    expect(summary.partialSourceWindows).toBe(0);
  });

  it("coalesces at most seven consecutive dates per source and never conflates separate sources",()=>{
    const sources=[{id:"city-calendar",name:"City",kind:"city_calendar" as const},
      {id:"arts",name:"Arts",kind:"arts" as const}];
    const roots=Array.from({length:9},(_,i)=>({
      source_key:i===8?"category:arts":"category:city-calendar",
      window_from:new Date(Date.UTC(2026,10,17+i)).toISOString().slice(0,10),
      window_to:new Date(Date.UTC(2026,10,17+i)).toISOString().slice(0,10),
      scan_from:new Date(Date.UTC(2026,10,17+i)).toISOString().slice(0,10),
      scan_to:new Date(Date.UTC(2026,10,17+i)).toISOString().slice(0,10),
      window_reason:"new_day" as const,status:"partial",
      search_attempted:false,is_scan_root:true,last_completed_at:null,
    }));
    const jobs=planCityResearchJobs(roots,sources,"2026-11-18");
    expect(jobs).toHaveLength(3);
    expect(jobs.filter(j=>j.key==="category:city-calendar")).toMatchObject([
      {from:"2026-11-17",to:"2026-11-23",reason:"new_day"},
      {from:"2026-11-24",to:"2026-11-24",reason:"new_day"},
    ]);
    expect(jobs.find(j=>j.key==="category:arts")).toMatchObject({
      from:"2026-11-25",to:"2026-11-25"});
    expect(jobs.flatMap(j=>j.roots)).toHaveLength(9);
  });

  it("resumes a saturated initial seven-day source at its saved child windows, not the wide root",async()=>{
    const s=mockStore();
    // Model migration 138's RPC guard: a scan-start timestamp older than a
    // post-research root write is ignored. Completion must use a fresh time.
    const realCoverageWrite=f.writeCoverage.getMockImplementation();
    f.writeCoverage.mockImplementation(async(db:unknown,write:Row)=>{
      const prior=s.tables.city_source_coverage.find(row=>
        row.city_key==="us|ca|example"&&row.source_key===write.sourceKey&&
        row.window_from===write.from&&row.window_to===write.to);
      if(prior&&write.checkedAt<prior.last_checked_at)return;
      return realCoverageWrite!(db,write);
    });
    const expected=[{name:"Public concert",startDate:"2026-11-04",
      sourceUrl:"https://city.example.org/concert"}];
    const original=f.city.getMockImplementation();
    f.city.mockImplementation(async(input:Row)=>{
      if(input.sources[0].id!=="city-calendar")return original!(input);
      const coverage=(from:string,to:string,outcome:string,events:Row[]=[]):Row=>({
        sourceId:input.sources[0].id,sourceKind:input.sources[0].kind,
        officialUrl:null,from,to,reason:input.window.reason,checkedAt:stamp,
        outcome,retryEligible:outcome==="partial",
        failure:outcome==="partial"?"invalid_shape":null,events,
      });
      if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-09")
        return {events:expected,sources:[
          coverage("2026-11-03","2026-11-06","partial",expected),
          coverage("2026-11-07","2026-11-09","partial")],
          duplicateCount:0,partial:true,retrySourceIds:["city-calendar"]};
      if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-06")
        return {events:expected,sources:[
          coverage("2026-11-03","2026-11-04","found",expected),
          coverage("2026-11-05","2026-11-06","none_found")],
          duplicateCount:0,partial:false,retrySourceIds:[]};
      if(input.window.from==="2026-11-07"&&input.window.to==="2026-11-09")
        return {events:[],sources:[
          coverage("2026-11-07","2026-11-09","none_found")],
          duplicateCount:0,partial:false,retrySourceIds:[]};
      return original!(input);
    });
    const window=eventScanWindows("2026-11-03",null,"location")[0];
    const first=await s.scoped(cafeA,"2026-11-03",window,{
      ...newLdiBudget(),cityTasks:40});
    expect(first?.completed).toBe(false);
    const source="category:city-calendar";
    const root=s.tables.city_source_coverage.find(r=>r.source_key===source&&
      r.window_from==="2026-11-03"&&r.window_to==="2026-11-09");
    expect(root).toMatchObject({status:"partial",is_scan_root:true});
    const rootSnapshot={...root!};
    // The in-memory Supabase fixture intentionally stores untyped database rows.
    const jobs=planCityResearchJobs(s.tables.city_source_coverage as unknown as
      Parameters<typeof planCityResearchJobs>[0],[
      {id:"city-calendar",name:"City",kind:"city_calendar"}],"2026-11-04");
    expect(jobs.map(j=>({from:j.from,to:j.to}))).toEqual([
      {from:"2026-11-03",to:"2026-11-06"},
      {from:"2026-11-07",to:"2026-11-09"},
    ]);
    const calls=f.city.mock.calls.length;
    expect((await s.scoped(cafeA,"2026-11-04",window,{
      ...newLdiBudget(),cityTasks:40}))?.completed).toBe(true);
    const retried=f.city.mock.calls.slice(calls).filter(([args])=>
      args.sources[0].id==="city-calendar");
    expect(retried.map(([args])=>[args.window.from,args.window.to])).toEqual([
      ["2026-11-03","2026-11-06"],["2026-11-07","2026-11-09"]]);
    const updated=s.tables.city_source_coverage.find(r=>r.source_key===source&&
      r.window_from==="2026-11-03"&&r.window_to==="2026-11-09");
    expect(updated).toMatchObject({is_scan_root:true,status:"found"});
    expect(reconciledCityRootStatus(rootSnapshot as unknown as
      Parameters<typeof reconciledCityRootStatus>[0],
      s.tables.city_source_coverage as unknown as
      Parameters<typeof reconciledCityRootStatus>[1])).toBe("found");
    const coverage=await readCityResearchCoverage(s.db,cafeA,"2026-11-03","2026-11-16");
    expect(coverage.status).toBe("complete");
  });

  it("narrows saturated multi-day new-day catch-up roots without re-searching the wide range",async()=>{
    const s=mockStore(),original=f.city.getMockImplementation();
    f.city.mockImplementation(async(input:Row)=>{
      if(input.sources[0].id!=="city-calendar")return original!(input);
      const make=(from:string,to:string,outcome:string):Row=>({
        sourceId:"city-calendar",sourceKind:"city_calendar",officialUrl:null,
        from,to,reason:input.window.reason,checkedAt:stamp,outcome,
        retryEligible:outcome==="partial",
        failure:outcome==="partial"?"invalid_shape":null,events:[],
      });
      let sources:Row[];
      if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-09"){
        sources=[make("2026-11-03","2026-11-06","partial"),
          make("2026-11-07","2026-11-09","partial")];
      }else if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-06"){
        sources=[make("2026-11-03","2026-11-04","none_found"),
          make("2026-11-05","2026-11-06","none_found")];
      }else if(input.window.from==="2026-11-07"&&input.window.to==="2026-11-09"){
        sources=[make("2026-11-07","2026-11-09","none_found")];
      }else sources=[make(input.window.from,input.window.to,"none_found")];
      return {events:[],sources,duplicateCount:0,
        partial:sources.some(c=>c.outcome==="partial"),retrySourceIds:[]};
    });
    const catchup={from:"2026-11-03",to:"2026-11-09",reason:"new_day" as const};
    const generous=()=>({...newLdiBudget(),cityTasks:40});
    expect((await s.scoped(cafeA,"2026-11-03",catchup,generous()))?.completed)
      .toBe(false);
    const source="category:city-calendar";
    const root=()=>s.tables.city_source_coverage.find(row=>row.is_scan_root&&
      row.source_key===source&&row.window_from==="2026-11-03"&&
      row.window_to==="2026-11-09");
    expect(root()).toMatchObject({status:"partial",window_reason:"new_day"});
    const jobs=planCityResearchJobs(s.tables.city_source_coverage as unknown as
      Parameters<typeof planCityResearchJobs>[0],[
      {id:"city-calendar",name:"City",kind:"city_calendar"}],"2026-11-04");
    expect(jobs.map(job=>[job.from,job.to])).toEqual([
      ["2026-11-03","2026-11-06"],["2026-11-07","2026-11-09"],
    ]);
    const calls=f.city.mock.calls.length;
    expect((await s.scoped(cafeA,"2026-11-04",catchup,generous()))?.completed)
      .toBe(true);
    expect(f.city.mock.calls.slice(calls).filter(([args])=>
      args.sources[0].id==="city-calendar").map(([args])=>[
      args.window.from,args.window.to,
    ])).toEqual([
      ["2026-11-03","2026-11-06"],["2026-11-07","2026-11-09"],
    ]);
    expect(root()?.status).toBe("none_found");
    expect((await readCityResearchCoverage(s.db,cafeA,"2026-11-03","2026-11-09"))
      .status).toBe("complete");
  });

  it("does not complete saturated ancestor coverage when A rejects a nested candidate write",async()=>{
    const s=mockStore();
    const initial=eventScanWindows("2026-11-03",null,"location")[0];
    const originalCity=f.city.getMockImplementation();
    const originalWrite=f.writeCity.getMockImplementation();
    let sourceFixed=false;
    f.writeCity.mockImplementation(async(db:unknown,candidate:Row)=>{
      if(candidate.sourceUrl.startsWith("http://"))
        throw Object.assign(new Error("HTTPS provenance required"),{code:"22023"});
      return originalWrite!(db,candidate);
    });
    f.city.mockImplementation(async(input:Row)=>{
      if(input.sources[0].id!=="city-calendar")return originalCity!(input);
      const coverage=(from:string,to:string,outcome:string,events:Row[]=[])=>({
        sourceId:"city-calendar",sourceKind:"city_calendar",officialUrl:null,
        from,to,reason:input.window.reason,checkedAt:stamp,outcome,
        retryEligible:outcome==="partial",
        failure:outcome==="partial"?"invalid_shape":null,events,
      });
      const event=[{name:"City arts fair",startDate:"2026-11-04",
        sourceUrl:(sourceFixed?"https://":"http://")+"city.example.org/arts"}];
      let sources:Row[];
      if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-09"){
        sources=[coverage("2026-11-03","2026-11-06","partial"),
          coverage("2026-11-07","2026-11-09","partial")];
      }else if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-06"){
        // B says its child searches succeeded; A still rejects one source.
        sources=[coverage("2026-11-03","2026-11-04","found",event),
          coverage("2026-11-05","2026-11-06","none_found")];
      }else if(input.window.from==="2026-11-03"&&input.window.to==="2026-11-04"){
        sources=[coverage("2026-11-03","2026-11-04","found",event)];
      }else if(input.window.from==="2026-11-07"&&input.window.to==="2026-11-09"){
        sources=[coverage("2026-11-07","2026-11-09","none_found")];
      }else sources=[coverage(input.window.from,input.window.to,"none_found")];
      return {events:sources.flatMap(c=>c.events),sources,duplicateCount:0,
        partial:sources.some(c=>c.outcome==="partial"),retrySourceIds:[]};
    });
    const generous=()=>({...newLdiBudget(),cityTasks:40});
    expect((await s.scoped(cafeA,"2026-11-03",initial,generous()))?.completed)
      .toBe(false);
    expect((await s.scoped(cafeA,"2026-11-04",initial,generous()))?.completed)
      .toBe(false);
    const root=()=>s.tables.city_source_coverage.find(row=>
      row.is_scan_root&&row.source_key==="category:city-calendar"&&
      row.window_from==="2026-11-03"&&row.window_to==="2026-11-09");
    const rejectedChild=s.tables.city_source_coverage.find(row=>
      !row.is_scan_root&&row.source_key==="category:city-calendar"&&
      row.window_from==="2026-11-03"&&row.window_to==="2026-11-04");
    expect(rejectedChild).toMatchObject({
      status:"partial",failure_category:"invalid_source_url"});
    expect(root()?.status).toBe("partial");
    expect(s.tables.city_events).toHaveLength(0);
    const jobs=planCityResearchJobs(s.tables.city_source_coverage as unknown as
      Parameters<typeof planCityResearchJobs>[0],[
      {id:"city-calendar",name:"City",kind:"city_calendar"}],"2026-11-05");
    expect(jobs.map(job=>[job.from,job.to])).toEqual([
      ["2026-11-03","2026-11-04"],
    ]);
    sourceFixed=true;
    expect((await s.scoped(cafeA,"2026-11-05",initial,generous()))?.completed)
      .toBe(true);
    expect(root()?.status).toBe("found");
    expect(s.tables.city_events).toHaveLength(1);
    expect(s.tables.city_event_sources[0].source_url)
      .toBe("https://city.example.org/arts");
  });
  it("keeps confirmed legacy multi-day duration and original kind in the canonical overlay",async()=>{
    const s=mockStore();
    s.tables.cafe_events.push({id:"66666666-6666-4666-8666-666666666666",
      business_id:cafeA,name:"Civic Fair",kind:"conference",
      start_date:"2026-11-04",end_date:"2026-11-06",
      start_time:null,end_time:null,venue:null,venue_address:null,
      area_label:null,source_url:"https://city.example.org/events/civic-fair",
      status:"found",found_at:stamp,last_checked_at:stamp});
    s.tables.city_events.push({id:cityId,city_key:"us|ca|example",
      name:"Civic Fair",kind:"other",start_date:"2026-11-04",
      end_date:"2026-11-04",start_time:null,end_time:null,
      venue:null,venue_address:null,last_checked_at:stamp});
    s.tables.city_event_sources.push({city_event_id:cityId,
      source_url:"https://city.example.org/events/civic-fair",observed_at:stamp});
    s.tables.cafe_city_event_links.push({business_id:cafeA,
      cafe_event_id:"66666666-6666-4666-8666-666666666666",city_event_id:cityId});
    const timeline=await readSavedEventTimeline(s.db,{businessId:cafeA,
      ownerUserId:"owner-a"},"2026-11-04","2026-11-06");
    expect(timeline.events[0]).toMatchObject({cityEventId:cityId,
      startDate:"2026-11-04",endDate:"2026-11-06",kind:"conference"});
    // WhatsApp, D's evidence reader, Home and chat call the SAME exported
    // readCafeEvents implementation; no raw-vs-overlaid version may leak.
    const whatsappAndEvidence=await readCafeEvents(s.db,cafeA,"2026-11-04","2026-11-06");
    expect(whatsappAndEvidence).toEqual(timeline.events);
  });
  it("includes enriched later dates even when the legacy café row ended earlier",async()=>{
    const s=mockStore(),legacyId="77777777-7777-4777-8777-777777777777";
    s.tables.cafe_events.push({id:legacyId,business_id:cafeA,
      name:"Convention",kind:"conference",start_date:"2026-11-04",
      end_date:"2026-11-04",start_time:null,end_time:null,venue:null,
      venue_address:null,area_label:null,
      source_url:"https://city.example.org/convention",
      status:"found",found_at:stamp,last_checked_at:stamp});
    s.tables.city_events.push({id:cityId,city_key:"us|ca|example",
      name:"Convention",kind:"conference",start_date:"2026-11-04",
      end_date:"2026-11-06",start_time:"09:00",end_time:"18:00",
      venue:"Center",venue_address:"20 Main St",
      time_source_url:"https://city.example.org/convention",
      last_checked_at:stamp});
    s.tables.city_event_sources.push({city_event_id:cityId,
      source_url:"https://city.example.org/convention",observed_at:stamp});
    s.tables.cafe_city_event_links.push({business_id:cafeA,
      cafe_event_id:legacyId,city_event_id:cityId});
    const saved=await readCafeEvents(s.db,cafeA,"2026-11-06","2026-11-06");
    expect(saved).toMatchObject([{id:legacyId,endDate:"2026-11-06",
      venue:"Center",startTime:"09:00",status:"found"}]);
    const timeline=await readSavedEventTimeline(s.db,
      {businessId:cafeA,ownerUserId:"owner-a"},"2026-11-06","2026-11-06");
    expect(timeline.events).toEqual(saved);
    expect(await readCafeEvents(s.db,cafeB,"2026-11-06","2026-11-06"))
      .toEqual([]);
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
