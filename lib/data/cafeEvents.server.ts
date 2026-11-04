import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readPrimaryLocation,type CafeLocation} from "./cafeLocation.server";
import {cityScopeKey,canonicalEventNameKey} from "@/lib/events/cityEventIdentity";
import {readOwnerProposals,readOwnerReports,type OwnerScope} from "@/lib/ai/supervisor/loop/reads.server";

export type CafeEvent={
 id:string;name:string;kind:string;startDate:string;endDate:string;
 startTime:string|null;endTime:string|null;venue:string|null;
 venueAddress:string|null;areaLabel:string|null;sourceUrl:string|null;
 status:"found"|"cancelled"|"moved";foundAt:string;lastCheckedAt:string;
 lastAttemptedAt?:string|null;lastVerifiedAt?:string|null;verificationFailedAt?:string|null;
 verificationDetails?:unknown;
 cityEventId?:string|null;sourceUrls?:string[];
};
export type EventChecklistTick={actionIndex:number;state:"done"|"dismissed"};
export type CityCatalogPage={available:boolean;missing:string|null;page:number;pageSize:number;total:number;hasMore:boolean;
 items:Array<{id:string;name:string;kind:string;startDate:string;endDate:string;
 startTime:string|null;endTime:string|null;timeSourceUrl:string|null;
 venue:string|null;venueAddress:string|null;checkedAt:string;
 sources:Array<{url:string;observedAt:string}>;cafeEventId:string|null;
  status:"found"|"cancelled"|"moved"|null;lastVerifiedAt:string|null}>};
export type CityCoverageOverview={
  status:"complete"|"partial"|"unsearched"|"unavailable";
  researchedSourceWindows:number;successfulSourceWindows:number;
  failedSourceWindows:number;partialSourceWindows:number;
  unsearchedSourceWindows:number;lastCompletedAt:string|null;
};
export type NeighborhoodCoverageItem={scope:string;status:string;retryEligible:boolean;
  checkedAt:string;lastCompletedAt:string|null;failureCategory:string|null};
export type SavedEventTimeline={
 cityCatalog?:CityCatalogPage;cityCoverage?:CityCoverageOverview;
 neighborhoodCoverage?:NeighborhoodCoverageItem[];
 neighborhood?:Array<{placeId:string;name:string;kind:string;
  address:string|null;sourceUrl:string;calendarUrl:string|null;visitorInfoUrl:string|null;
  visitorApproach:string|null;entrance:string|null;assessment:string;
  rationale:string|null;checkedAt:string}>;
 events:CafeEvent[];
 plans:Array<{proposalId:string;threadId:string;status:string;revision:number;
   startDate:string;endDate:string;eventIds?:string[];summary:string;actions:unknown;expectedBusyHours:unknown;
   factsHash:string;importance?:"high"|"medium"|"low"|null;
   reportStatus:string|null;report:unknown|null}>;
};

function assertRange(from:string,to:string){
 const day=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&
   !Number.isNaN(Date.parse(value+"T00:00:00Z"))&&
   new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
 if(!day(from)||!day(to)||from>to||
   Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z")>90*86400000)
   throw new Error("Invalid café event range");
}

/** Private raw table adapter. Public reads use readCafeEvents below. */
async function readStoredCafeEvents(db:SupabaseClient,businessId:string,
  from:string,to:string,ids?:readonly string[]):Promise<CafeEvent[]>{
 assertRange(from,to);
 let query=db.from("cafe_events")
   .select("id,name,kind,start_date,end_date,start_time,end_time,venue,venue_address,area_label,source_url,status,found_at,last_checked_at,last_verification_attempt_at,last_verified_at,verification_failed_at,verification_details")
   .eq("business_id",businessId);
 query=ids?.length?query.in("id",[...ids]):
   query.lte("start_date",to).gte("end_date",from);
 const {data,error}=await query
   .order("start_date",{ascending:true}).order("id",{ascending:true}).limit(500);
 if(error)throw error;
 return (data??[]).map(row=>({
   id:row.id,name:row.name,kind:row.kind,startDate:row.start_date,endDate:row.end_date,
   startTime:row.start_time,endTime:row.end_time,venue:row.venue,
   venueAddress:row.venue_address,areaLabel:row.area_label,sourceUrl:row.source_url,
   status:row.status as CafeEvent["status"],foundAt:row.found_at,lastCheckedAt:row.last_checked_at,
   lastAttemptedAt:row.last_verification_attempt_at,lastVerifiedAt:row.last_verified_at,
   verificationFailedAt:row.verification_failed_at,verificationDetails:row.verification_details,
 }));
}
export async function readEventChecklist(db:SupabaseClient,businessId:string,
 proposalId:string):Promise<EventChecklistTick[]>{
 const {data,error}=await db.from("cafe_event_checklist").select("action_index,state")
   .eq("business_id",businessId).eq("proposal_id",proposalId).order("action_index");
 if(error)throw error;
 return (data??[]).map(row=>({actionIndex:row.action_index,state:row.state as EventChecklistTick["state"]}));
}

/** Both Supervisor chat and the future event panel use this saved-data view.
 * Plans/reports are read from the EXISTING Supervisor ledger, never copied. */
export async function readSavedEventTimeline(db:SupabaseClient,scope:OwnerScope,
  from:string,to:string,options:{cityEventId?:string}={}):Promise<SavedEventTimeline>{
 assertRange(from,to);
 const [events,proposals,cityCatalog,neighborhood,cityCoverage,neighborhoodCoverage]=await Promise.all([
   readCanonicalCafeEvents(db,scope.businessId,from,to),
   readOwnerProposals(db,scope,{capabilityId:"alex.event_readiness.v1",limit:200}),
   readCityEventCatalog(db,scope.businessId,from,to,
     options.cityEventId?{page:0,pageSize:1,cityEventId:options.cityEventId}:{}),
   readCafeNeighborhoodEvidence(db,scope.businessId),
   readCityResearchCoverage(db,scope.businessId,from,to),
   readNeighborhoodResearchCoverage(db,scope.businessId),
 ]);
 const plans=proposals.flatMap(p=>{
   const effect=p.canonical_effect_payload as Record<string,unknown>|null;
   if(!effect||typeof effect.startDate!=="string"||typeof effect.endDate!=="string"||
     effect.startDate>to||effect.endDate<from)return [];
   return [{p,effect}];
 });
 const reports=await readOwnerReports(db,scope,plans.map(x=>x.p.id),{limit:200});
 const byProposal=new Map(reports.map(r=>[r.proposal_id,r]));
 return {events,cityCatalog,neighborhood,cityCoverage,neighborhoodCoverage,plans:plans.map(({p,effect})=>{
   const report=byProposal.get(p.id);
   return {proposalId:p.id,threadId:p.thread_id,status:p.status,revision:p.revision,
     startDate:String(effect.startDate),endDate:String(effect.endDate),
     // Preserve identity from the existing owner-scoped Supervisor proposal.
     // A legacy day-only plan without event IDs must never be assigned to an event.
     eventIds:Array.isArray(effect.eventIds)?effect.eventIds.filter(
       (id):id is string=>typeof id==="string"):[],
     summary:typeof effect.summary==="string"?effect.summary:"",
     actions:effect.actions??[],expectedBusyHours:effect.expectedBusyHours??[],
     factsHash:typeof effect.factsHash==="string"?effect.factsHash:"",
     // Optional metadata from B; old proposals remain readable without an invented rank.
     importance:effect.importance==="high"||effect.importance==="medium"||effect.importance==="low"
       ?effect.importance:null,
     reportStatus:report?.status??null,report:report?.report??null};
 })};
}


type SharedRow={id:string;name:string;kind:string;start_date:string;end_date:string;
  start_time:string|null;end_time:string|null;time_source_url:string|null;
  venue:string|null;venue_address:string|null;last_checked_at:string};
type SourceRow={city_event_id:string;source_url:string;observed_at:string};
type LinkRow={cafe_event_id:string;city_event_id:string};
const missingSchema=(error:unknown)=>!!error&&typeof error==="object"&&"code" in error&&
  ["42P01","42703","PGRST205","PGRST204"].includes(String(error.code));
const ensureShared=(error:unknown)=>{if(error)throw error;};
async function sourceRows(db:SupabaseClient,ids:string[]):Promise<SourceRow[]>{
  if(!ids.length)return [];
  const {data,error}=await db.from("city_event_sources")
    .select("city_event_id,source_url,observed_at").in("city_event_id",ids)
    .order("observed_at",{ascending:false}).limit(2000);
  ensureShared(error);
  return (data??[]) as SourceRow[];
}
async function cityKeyForCafe(db:SupabaseClient,businessId:string){
  const row=await readPrimaryLocation(db,businessId);
  if(!row?.city||!row.region||!row.country_code)return null;
  try{return cityScopeKey({city:row.city,region:row.region,countryCode:row.country_code});}
  catch{return null;}
}
/** One RLS-scoped, date-bounded, paginated source of city facts.
 * Do not run web research when an owner opens the panel. */
export async function readCityEventCatalog(db:SupabaseClient,businessId:string,
  from:string,to:string,options:{page?:number;pageSize?:number;kind?:string;search?:string;cityEventId?:string}={}):Promise<CityCatalogPage>{
  assertRange(from,to);
  const page=Number.isInteger(options.page)&&options.page!>=0?options.page!:0;
  const pageSize=Number.isInteger(options.pageSize)&&options.pageSize!>0?
    Math.min(100,options.pageSize!):50;
  const empty=(missing:string):CityCatalogPage=>({
    available:false,missing,page,pageSize,total:0,hasMore:false,items:[]});
  const cityKey=await cityKeyForCafe(db,businessId);
  if(!cityKey)return empty("city_region_country_missing");
  const validKinds=["festival","conference","sports","parade","community","other"];
  const kind=options.kind&&validKinds.includes(options.kind)?options.kind:null;
  const search=options.search?.trim().slice(0,80)??"";
  let query=db.from("city_events")
    .select("id,name,kind,start_date,end_date,start_time,end_time,time_source_url,venue,venue_address,last_checked_at",{count:"exact"})
    .eq("city_key",cityKey).lte("start_date",to).gte("end_date",from);
  if(kind)query=query.eq("kind",kind);
  if(options.cityEventId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.cityEventId))
      throw new Error("invalid_city_event_id");
    query=query.eq("id",options.cityEventId);
  }
  // Escape LIKE wildcards so user input is a literal name fragment.
  if(search)query=query.ilike("name","%"+search.replace(/[%_\\]/g,match=>"\\"+match)+"%");
  const {data,count,error}=await query.order("start_date",{ascending:true})
    .order("id",{ascending:true}).range(page*pageSize,(page+1)*pageSize-1);
  if(missingSchema(error))return empty("migration_pending");
  ensureShared(error);
  const city=(data??[]) as SharedRow[];
  const ids=city.map(row=>row.id);
  const [sources,links]=await Promise.all([
    sourceRows(db,ids),
    ids.length?db.from("cafe_city_event_links").select("cafe_event_id,city_event_id")
      .eq("business_id",businessId).in("city_event_id",ids):
      Promise.resolve({data:[] as LinkRow[],error:null}),
  ]);
  ensureShared(links.error);
  const linkedIds=((links.data??[]) as LinkRow[]).map(l=>l.cafe_event_id);
  const linked=linkedIds.length?await db.from("cafe_events")
    .select("id,status,last_verified_at").eq("business_id",businessId).in("id",linkedIds):
    {data:[] as Array<{id:string;status:string;last_verified_at:string|null}>,error:null};
  ensureShared(linked.error);
  const byLegacy=new Map((linked.data??[]).map(row=>[row.id,row]));
  const bySource=new Map<string,Array<{url:string;observedAt:string}>>();
  for(const s of sources)bySource.set(s.city_event_id,
    [...(bySource.get(s.city_event_id)??[]),{url:s.source_url,observedAt:s.observed_at}]);
  const byCity=new Map(((links.data??[]) as LinkRow[]).map(l=>[l.city_event_id,l.cafe_event_id]));
  const total=count??city.length;
  return {available:true,missing:null,page,pageSize,total,hasMore:(page+1)*pageSize<total,
    items:city.map(e=>({id:e.id,name:e.name,kind:e.kind,
      startDate:e.start_date,endDate:e.end_date,
      startTime:e.start_time,endTime:e.end_time,timeSourceUrl:e.time_source_url,
      venue:e.venue,
      venueAddress:e.venue_address,checkedAt:e.last_checked_at,
      sources:bySource.get(e.id)??[],cafeEventId:byCity.get(e.id)??null,
      status:(byLegacy.get(byCity.get(e.id)??"")?.status??null) as CityCatalogPage["items"][number]["status"],
      lastVerifiedAt:byLegacy.get(byCity.get(e.id)??"")?.last_verified_at??null}))};
}
/** Private owner-scoped evidence and source details; shared place facts have no
 * café impact theory or POS data. */
export async function readCafeNeighborhoodEvidence(db:SupabaseClient,businessId:string):
  Promise<NonNullable<SavedEventTimeline["neighborhood"]>>{
  const {data,error}=await db.from("cafe_neighborhood_evidence")
    .select("place_id,assessment,rationale,checked_at")
    .eq("business_id",businessId).order("checked_at",{ascending:false}).limit(100);
  if(missingSchema(error))return [];
  ensureShared(error);
  const records=data??[];
  if(!records.length)return [];
  const places=await db.from("city_places")
    .select("id,name,kind,address,source_url,calendar_url,visitor_info_url,visitor_approach,entrance")
    .in("id",records.map(r=>r.place_id));
  if(missingSchema(places.error))return [];
  ensureShared(places.error);
  const byId=new Map((places.data??[]).map(row=>[row.id,row]));
  return records.flatMap(row=>{
    const p=byId.get(row.place_id);
    return p?[{placeId:row.place_id,name:p.name,kind:p.kind,address:p.address,
      sourceUrl:p.source_url,calendarUrl:p.calendar_url,visitorInfoUrl:p.visitor_info_url,
      visitorApproach:p.visitor_approach,entrance:p.entrance,
      assessment:row.assessment,rationale:row.rationale,checkedAt:row.checked_at}]:[];
  });
}
async function overlayCityFacts(db:SupabaseClient,businessId:string,
  legacy:CafeEvent[]):Promise<CafeEvent[]>{
  if(!legacy.length)return legacy;
  const {data,error}=await db.from("cafe_city_event_links")
    .select("cafe_event_id,city_event_id").eq("business_id",businessId)
    .in("cafe_event_id",legacy.map(e=>e.id)).limit(2000);
  if(missingSchema(error))return legacy;
  ensureShared(error);
  const links=(data??[]) as LinkRow[];
  if(!links.length)return legacy;
  const ids=[...new Set(links.map(l=>l.city_event_id))];
  const [{data:city,error:cityError},sources]=await Promise.all([
    db.from("city_events").select("id,name,kind,start_date,end_date,start_time,end_time,time_source_url,venue,venue_address,last_checked_at")
      .in("id",ids),sourceRows(db,ids),
  ]);
  if(missingSchema(cityError))return legacy;
  ensureShared(cityError);
  const shared=new Map(((city??[]) as SharedRow[]).map(row=>[row.id,row]));
  const byCafe=new Map(links.map(row=>[row.cafe_event_id,row.city_event_id]));
  const bySource=new Map<string,string[]>();
  for(const row of sources)bySource.set(row.city_event_id,
    [...(bySource.get(row.city_event_id)??[]),row.source_url]);
  return legacy.map(e=>{
    const id=byCafe.get(e.id),fact=id?shared.get(id):null;
    if(!id||!fact)return e;
    return {...e,cityEventId:id,name:fact.name,
      // Compact three-field discovery never downgrades a documented category
      // or shortens a confirmed multi-day event. Existing status is authoritative.
      kind:fact.kind==="other"&&e.kind!=="other"?e.kind:fact.kind,
      startDate:e.startDate,endDate:e.endDate>fact.end_date?e.endDate:fact.end_date,
      startTime:e.startTime??fact.start_time,endTime:e.endTime??fact.end_time,
      venue:e.venue??fact.venue,venueAddress:e.venueAddress??fact.venue_address,
      sourceUrls:bySource.get(id)??[]};
  });
}

/** A's public source/window ledger is read through this SAME canonical Events
 * facade, with the unsent/search-failed distinction preserved for the UI/chat. */
export async function readCityResearchCoverage(db:SupabaseClient,businessId:string,
  from:string,to:string):Promise<CityCoverageOverview>{
  assertRange(from,to);
  const empty=(status:CityCoverageOverview["status"]):CityCoverageOverview=>({
    status,researchedSourceWindows:0,successfulSourceWindows:0,
    failedSourceWindows:0,partialSourceWindows:0,
    unsearchedSourceWindows:0,lastCompletedAt:null,
  });
  const cityKey=await cityKeyForCafe(db,businessId);
  if(!cityKey)return empty("unavailable");
  const {data,error}=await db.from("city_source_coverage")
    .select("status,search_attempted,last_completed_at")
    .eq("city_key",cityKey).eq("is_scan_root",true)
    .lte("window_from",to).gte("window_to",from)
    .order("window_from").limit(4000);
  if(missingSchema(error))return empty("unavailable");
  ensureShared(error);
  const rows=data??[];
  if(!rows.length)return empty("unsearched");
  let successful=0,failed=0,partial=0,unsearched=0,attempted=0;
  let latest:string|null=null;
  for(const row of rows){
    if(!row.search_attempted)unsearched++;
    else attempted++;
    if(row.status==="failed")failed++;
    else if(row.status==="partial")partial++;
    else if(row.status==="found"||row.status==="none_found")successful++;
    if(row.last_completed_at&&(!latest||row.last_completed_at>latest))
      latest=row.last_completed_at;
  }
  return {
    status:unsearched||failed||partial?"partial":"complete",
    researchedSourceWindows:attempted,successfulSourceWindows:successful,
    failedSourceWindows:failed,partialSourceWindows:partial,
    unsearchedSourceWindows:unsearched,lastCompletedAt:latest,
  };
}

/** A shared, corroborated event can be extended past its original café
 * row's end date. Query the linked city date range first, then fetch ONLY
 * this café's existing UUIDs. Otherwise a later-day morning brief would see
 * no raw row to overlay even though Home knows the confirmed later date.
 * City paging is exhaustive; never treat a truncated page as no events. */
async function extendedLinkedCafeIds(db:SupabaseClient,businessId:string,
  from:string,to:string,already:ReadonlySet<string>):Promise<string[]>{
  const cityKey=await cityKeyForCafe(db,businessId);
  if(!cityKey)return [];
  const matchingCityIds:string[]=[];
  for(let page=0;;page++){
    if(page>=100)throw new Error("city_events_date_range_too_large");
    const {data,error}=await db.from("city_events").select("id")
      .eq("city_key",cityKey).lte("start_date",to).gte("end_date",from)
      .order("id").range(page*200,page*200+199);
    if(missingSchema(error))return [];
    ensureShared(error);
    matchingCityIds.push(...(data??[]).map(r=>r.id));
    if((data??[]).length<200)break;
  }
  const result=new Set<string>();
  for(let i=0;i<matchingCityIds.length;i+=100){
    const {data,error}=await db.from("cafe_city_event_links")
      .select("cafe_event_id,city_event_id").eq("business_id",businessId)
      .in("city_event_id",matchingCityIds.slice(i,i+100));
    if(missingSchema(error))return [];
    ensureShared(error);
    for(const link of data??[])
      if(!already.has(link.cafe_event_id))result.add(link.cafe_event_id);
  }
  return [...result];
}
/** One canonical business-scoped event-fact reader for every consumer.
 * The raw pre-migration table is private; both public export names below are
 * the EXACT same function, with a safe legacy fallback before migrations 137/138.
 * No scheduled research, search, or second overlay implementation here. */
export async function readCafeEvents(db:SupabaseClient,businessId:string,
  from:string,to:string):Promise<CafeEvent[]>{
  const raw=await readStoredCafeEvents(db,businessId,from,to);
  const known=new Set(raw.map(e=>e.id));
  const ids=await extendedLinkedCafeIds(db,businessId,from,to,known);
  const extended:CafeEvent[]=[];
  for(let i=0;i<ids.length;i+=100)
    extended.push(...await readStoredCafeEvents(db,businessId,from,to,ids.slice(i,i+100)));
  const canonical=await overlayCityFacts(db,businessId,[...raw,...extended]);
  const location=await readPrimaryLocation(db,businessId);
  return visibleCafeEventListings(canonical,from,to,location);
}
export const readCanonicalCafeEvents=readCafeEvents;



/** Location-aware evidence only: unknown venue positions stay visible.
 * Saved explicit distance wins; otherwise a complete venue city/address can
 * establish that a listing is outside the café's recorded municipality.
 * The schema has no geocoded café/event coordinates, so never invent distance. */
export function cafeEventInArea(event:Pick<CafeEvent,"venueAddress"|"areaLabel">,
  location:Pick<CafeLocation,"city"|"region">|null):boolean{
  if(!location?.city)return true;
  const distance=event.areaLabel?.match(/\b(\d+(?:\.\d+)?)\s*(miles?|mi|kilometers?|km)\b/iu);
  if(distance){
    const amount=Number(distance[1]);
    const miles=/^(km|kilometer)/iu.test(distance[2])?amount/1.609344:amount;
    return miles<=40;
  }
  const address=event.venueAddress?.split(",").map(part=>part.trim()).filter(Boolean)??[];
  // Only an unambiguous city + region address is strong enough to exclude.
  if(address.length<3||!location.region)return true;
  const clean=(value:string)=>value.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase()
    .replace(/[^a-z0-9]/gu,"");
  const region=clean(location.region);
  const regionPart=clean(address.at(-1)??"");
  if(!regionPart.startsWith(region)&&!region.startsWith(regionPart))return false;
  const venueCity=clean(address.at(-2)??"");
  return !venueCity||venueCity===clean(location.city);
}

/** Display projection over the ONE saved Events reader. Stored facts and
 * approval identities are unchanged; unknown geography is never discarded. */
export function visibleCafeEventListings(canonical:readonly CafeEvent[],from:string,to:string,
  location:Pick<CafeLocation,"city"|"region">|null):CafeEvent[]{
  const events=canonical.filter(e=>e.startDate<=to&&e.endDate>=from)
    .filter(e=>cafeEventInArea(e,location));
  const unique=new Map<string,CafeEvent>();
  for(const e of events){
    const key=e.startDate+"|"+canonicalEventNameKey(e.name);
    const prior=unique.get(key);
    if(!prior||Number(Boolean(e.lastVerifiedAt))>Number(Boolean(prior.lastVerifiedAt))||
       (!prior.cityEventId&&!!e.cityEventId))unique.set(key,e);
  }
  return [...unique.values()];
}

/** Private neighborhood scope freshness, through the sole owner Events facade. */
export async function readNeighborhoodResearchCoverage(db:SupabaseClient,businessId:string):
  Promise<NeighborhoodCoverageItem[]>{
  const {data,error}=await db.from("cafe_neighborhood_source_coverage")
    .select("scope,status,retry_eligible,checked_at,last_completed_at,failure_category")
    .eq("business_id",businessId).order("scope").limit(4);
  if(missingSchema(error))return [];
  ensureShared(error);
  return (data??[]).map(r=>({scope:r.scope,status:r.status,
    retryEligible:r.retry_eligible,checkedAt:r.checked_at,
    lastCompletedAt:r.last_completed_at,failureCategory:r.failure_category}));
}
