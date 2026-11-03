import "server-only";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {CafeLocation} from "@/lib/data/cafeLocation.server";
import {cityScopeKey,canonicalSourceUrl,type CityScope,type CityEventKind,type CityPlaceKind} from "./cityEventIdentity";
import {upsertCityEventFact,recordCitySourceCoverage,upsertCafeNeighborhoodEvidence,
  linkCityEventToCafeEvent} from "./cityEventPersistence.server";
import {createCitySourceResearch} from "./citySourceResearch.server";
// B is the sole research implementation. Cap its per-source provider attempts here
// so multiple cafés, monitoring and plan generation fit the existing 300s cron.
const researchCitySources=createCitySourceResearch({maxSearches:3});
import {defaultCityResearchSources,cityResearchDateSlices,type CityResearchSource,
  type CitySourceResearchResult} from "./citySourceResearch";
import {researchNeighborhood} from "./neighborhoodResearch.server";
import {hasResearchableAddress,NEIGHBORHOOD_SCOPE_IDS,
  type PublicDemandPlace} from "./neighborhoodResearch";
import type {EventScanWindow} from "./eventsLookahead";
import {stableMessageId} from "@/lib/ai/supervisor/loop/supabase.server";
import {enrichCityEventFact,type ConfirmedEventEnrichment} from "./cityEventEnrichment.server";

type Db=SupabaseClient;
type CoverageRow={source_key:string;window_from:string;window_to:string;
  scan_from:string;scan_to:string;window_reason:EventScanWindow["reason"];
  status:string;search_attempted:boolean;is_scan_root:boolean;
  last_completed_at:string|null};
type NeighborhoodRow={scope:string;address_hash:string;status:string;
  retry_eligible:boolean;checked_at:string};
export type LdiBudget={cityTasks:number;neighborhoodScopes:number;
  enrichmentsRemaining:number;attempted:Set<string>};
export const newLdiBudget=():LdiBudget=>({cityTasks:6,neighborhoodScopes:4,
  enrichmentsRemaining:2,attempted:new Set()});
const complete=(status:string)=>status==="found"||status==="none_found";
const hash=(input:string)=>createHash("sha256").update(input).digest("hex");
const errorCode=(e:unknown)=>e&&typeof e==="object"&&"code" in e?String(e.code):"";
const missingTable=(e:unknown)=>["42P01","PGRST205","PGRST204"].includes(errorCode(e));
const assertOk=(error:unknown)=>{if(error)throw error;};
const pageSize=250;

/** E's additive schema is an activation boundary; 137 by itself is not enough.
 * Missing migrations use the existing legacy cron path, never a second search. */
export async function ldiSchemaReady(db:Db):Promise<boolean>{
  const result=await db.from("cafe_neighborhood_source_coverage").select("scope").limit(1);
  if(missingTable(result.error))return false;
  assertOk(result.error);
  return true;
}
function cityScope(location:CafeLocation):CityScope|null{
  if(!location.city||!location.region||!location.countryCode)return null;
  try{
    const scope={city:location.city,region:location.region,countryCode:location.countryCode};
    cityScopeKey(scope);
    return scope;
  }catch{return null;}
}
function sourceKey(s:CityResearchSource):string{
  return s.officialUrl?"venue:"+hash(canonicalSourceUrl(s.officialUrl)):
    "category:"+s.id;
}
function eventKind():CityEventKind{
  // B returns only name, date and URL. Its SOURCE category does not verify an
  // EVENT category (a sports calendar may include charity fairs, etc.).
  return "other";
}
const placeKind=(type:PublicDemandPlace["type"]):CityPlaceKind=>
  type==="hospital"?"medical":type==="recurring_activity"?"other":type;
function asVenueSource(p:{identity_key:string;name:string;calendar_url:string|null}):
  CityResearchSource|null{
  if(!p.calendar_url)return null;
  try{
    canonicalSourceUrl(p.calendar_url);
    return {id:"venue-"+p.identity_key.slice(0,22),
      name:p.name.slice(0,120),kind:"venue",officialUrl:p.calendar_url};
  }catch{return null;}
}
async function rows<T>(query:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:unknown}>,
  max=5000):Promise<T[]>{
  const all:T[]=[];
  while(all.length<max){
    const response=await query(all.length,all.length+pageSize-1);
    assertOk(response.error);
    const batch=response.data??[];
    all.push(...batch);
    if(batch.length<pageSize)break;
  }
  return all;
}
async function neighborhood(db:Db,businessId:string,location:CafeLocation,scope:CityScope,
  budget:LdiBudget,now:string):Promise<void>{
  // No owner observation is an input. Only the saved profile street address qualifies.
  if(location.source!=="profile"||!hasResearchableAddress(location)||budget.neighborhoodScopes<=0)
    return;
  const addressHash=hash(location.label.trim().toLowerCase());
  const history=await rows<NeighborhoodRow>((from,to)=>db.from("cafe_neighborhood_source_coverage")
    .select("scope,address_hash,status,retry_eligible,checked_at").eq("business_id",businessId)
    .range(from,to));
  const byScope=new Map(history.filter(r=>r.address_hash===addressHash).map(r=>[r.scope,r]));
  const due=NEIGHBORHOOD_SCOPE_IDS.filter(id=>{
    const last=byScope.get(id);
    return !last||last.retry_eligible||!complete(last.status)||
      Date.parse(now)-Date.parse(last.checked_at)>=7*86400000;
  }).slice(0,budget.neighborhoodScopes);
  if(!due.length)return;
  budget.neighborhoodScopes-=due.length;
  const result=await researchNeighborhood({address:{
    label:location.label,city:location.city,region:location.region,
    countryCode:location.countryCode},scopes:due});
  const hypotheses=new Map(result.cafeHypotheses.map(h=>[h.placeKey,h]));
  for(const place of result.publicPlaces){
    const hypothesis=hypotheses.get(place.placeKey);
    const saved=await upsertCafeNeighborhoodEvidence(db,{
      ...scope,businessId,name:place.name,kind:placeKind(place.type),
      address:place.address,sourceUrl:place.sourceUrl,calendarUrl:place.calendarUrl,
      checkedAt:place.checkedAt,assessment:hypothesis?"potential":"unknown",
      rationale:hypothesis?.possibleConnection??null,
    });
    // Add only cited public claims; do not erase older verified details with null.
    const evidence:Record<string,unknown>={source_status:place.sourceStatus,
      source_checked_at:place.checkedAt};
    for(const [column,value] of [
      ["visitor_info_url",place.visitorInfoUrl],
      ["visitor_approach",place.visitorApproach],
      ["visitor_approach_source_url",place.visitorApproachSourceUrl],
      ["entrance",place.entrance],
      ["entrance_source_url",place.entranceSourceUrl],
    ] as const)if(value!==null)evidence[column]=value;
    const updated=await db.from("city_places").update(evidence).eq("id",saved.placeId)
      .lte("last_checked_at",place.checkedAt);
    assertOk(updated.error);
  }
  for(const coverage of result.coverage){
    const last=byScope.get(coverage.scope);
    // Preserve an earlier complete read when a newer scoped retry fails.
    const written=await db.from("cafe_neighborhood_source_coverage").upsert({
      business_id:businessId,scope:coverage.scope,address_hash:addressHash,
      status:coverage.outcome,retry_eligible:coverage.retryEligible,
      checked_at:coverage.checkedAt,failure_category:coverage.failure,
      places_found:coverage.placesFound,discarded_candidates:coverage.discardedCandidates,
      last_completed_at:complete(coverage.outcome)?coverage.checkedAt:
        last?.address_hash===addressHash&&complete(last.status)?last.checked_at:null,
    },{onConflict:"business_id,scope"});
    assertOk(written.error);
  }
}
async function sourcesForCity(db:Db,cityKey:string):Promise<CityResearchSource[]>{
  const places=await rows<{identity_key:string;name:string;calendar_url:string|null}>(
    (from,to)=>db.from("city_places").select("identity_key,name,calendar_url")
      .eq("city_key",cityKey).not("calendar_url","is",null)
      .order("identity_key",{ascending:true}).range(from,to),1000);
  const defaults=defaultCityResearchSources();
  const seen=new Set<string>();
  const venue:CityResearchSource[]=[];
  for(const p of places){
    const s=asVenueSource(p);
    if(!s)continue;
    const key=sourceKey(s);
    if(seen.has(key))continue;
    seen.add(key);venue.push(s);
  }
  return [...defaults,...venue];
}
async function allCoverage(db:Db,cityKey:string):Promise<CoverageRow[]>{
  return rows<CoverageRow>((from,to)=>db.from("city_source_coverage")
    .select("source_key,window_from,window_to,scan_from,scan_to,window_reason,status,search_attempted,is_scan_root,last_completed_at")
    .eq("city_key",cityKey).order("scan_from").order("window_from")
    .range(from,to),5000);
}
function matchingCoverage(all:CoverageRow[],key:string,from:string,to:string){
  return all.find(r=>r.source_key===key&&r.window_from===from&&r.window_to===to);
}
function needsRefresh(r:CoverageRow|undefined,reason:EventScanWindow["reason"],epoch:string){
  if(!r||!complete(r.status))return true;
  // A Monday pass must see later announcements even if a prior scan covered the dates.
  return reason==="weekly"&&(!r.last_completed_at||
    r.last_completed_at.slice(0,10)<epoch);
}
async function persistCandidate(db:Db,scope:CityScope,kind:CityEventKind,
  candidate:{name:string;startDate:string;sourceUrl:string},checkedAt:string,
  enrichment:ConfirmedEventEnrichment|null){
  // B verifies exact dates, but accepts HTTP links for backward compatibility.
  // A deliberately accepts only HTTPS public provenance. No fabricated rewrite.
  const stored=await upsertCityEventFact(db,{...scope,name:candidate.name,
    startDate:candidate.startDate,kind,sourceUrl:candidate.sourceUrl,checkedAt,
    ...(enrichment?{endDate:enrichment.endDate,venue:enrichment.venue,
      venueAddress:enrichment.venueAddress}:{})});
  if(enrichment&&(enrichment.startTime||enrichment.endTime)){
    // Supplemental hours live ON A's same canonical city row, with original
    // cited event-page provenance; no parallel Events authority is introduced.
    const patch:Record<string,unknown>={
      time_source_url:enrichment.evidenceUrl,last_enriched_at:checkedAt,
    };
    if(enrichment.startTime)patch.start_time=enrichment.startTime;
    if(enrichment.endTime)patch.end_time=enrichment.endTime;
    const update=await db.from("city_events").update(patch).eq("id",stored.cityEventId);
    assertOk(update.error);
  }
}
async function studyOne(db:Db,scope:CityScope,source:CityResearchSource,
  from:string,to:string,reason:EventScanWindow["reason"],key:string,
  budget:LdiBudget){
  const result:CitySourceResearchResult=await researchCitySources({
    ...scope,window:{from,to,reason},sources:[source]});
  let rejected=0,saved=0;
  const checkedAt=new Date().toISOString();
  for(const coverage of result.sources){
    for(const event of coverage.events){
      try{
        let enrichment:ConfirmedEventEnrichment|null=null;
        if(budget.enrichmentsRemaining>0&&
          (source.kind==="city_calendar"||source.kind==="venue")){
          budget.enrichmentsRemaining--;
          enrichment=await enrichCityEventFact({...scope,...event});
        }
        await persistCandidate(db,scope,eventKind(),event,checkedAt,enrichment);
        saved++;
      }
      catch(error){
        // One invalid source must not erase valid event facts or mark coverage complete.
        if(errorCode(error)&&!["22023","23514"].includes(errorCode(error)))throw error;
        rejected++;
      }
    }
    // Retain source-specific nested windows, including saturation and failures.
    await recordCitySourceCoverage(db,{...scope,sourceKey:key,from:coverage.from,to:coverage.to,
      checkedAt:coverage.checkedAt,status:coverage.outcome});
  }
  const statuses=result.sources.map(c=>c.outcome);
  const status=statuses.length===0?"failed":
    statuses.every(s=>s==="failed")?"failed":
    rejected||result.partial?"partial":saved>0?"found":"none_found";
  await recordCitySourceCoverage(db,{...scope,sourceKey:key,from,to,checkedAt,status});
  const failure=result.sources.find(c=>c.failure)?.failure??(rejected?"invalid_source_url":null);
  const updated=await db.from("city_source_coverage").update({
    search_attempted:true,failure_category:failure,
  }).eq("city_key",cityScopeKey(scope)).eq("source_key",key)
    .eq("window_from",from).eq("window_to",to);
  assertOk(updated.error);
  return saved;
}
type CityRow={id:string;name:string;kind:string;start_date:string;end_date:string;
  start_time:string|null;end_time:string|null;
  venue:string|null;venue_address:string|null;last_checked_at:string};
async function associateCityFacts(db:Db,businessId:string,cityKey:string,from:string,to:string){
  const city=await rows<CityRow>((offset,end)=>db.from("city_events")
    .select("id,name,kind,start_date,end_date,start_time,end_time,venue,venue_address,last_checked_at")
    .eq("city_key",cityKey).lte("start_date",to).gte("end_date",from)
    .order("start_date").order("id").range(offset,end),5000);
  if(!city.length)return 0;
  const ids=city.map(e=>e.id);
  const sources=await rows<{city_event_id:string;source_url:string}>((start,end)=>
    db.from("city_event_sources").select("city_event_id,source_url")
      .in("city_event_id",ids).order("city_event_id").order("source_url")
      .range(start,end),5000);
  const linked=await rows<{city_event_id:string;cafe_event_id:string}>((start,end)=>
    db.from("cafe_city_event_links").select("city_event_id,cafe_event_id")
      .eq("business_id",businessId).in("city_event_id",ids).range(start,end),5000);
  const existing=await rows<{id:string;name:string;start_date:string;source_url:string|null}>(
    (start,end)=>db.from("cafe_events").select("id,name,start_date,source_url")
      .eq("business_id",businessId).lte("start_date",to).gte("end_date",from)
      .range(start,end),5000);
  const byCity=new Map(linked.map(r=>[r.city_event_id,r.cafe_event_id]));
  const sourceMap=new Map<string,string[]>();
  for(const s of sources)sourceMap.set(s.city_event_id,
    [...(sourceMap.get(s.city_event_id)??[]),s.source_url]);
  const bySource=new Map<string,string[]>();
  for(const e of existing)if(e.source_url){
    try{
      const k=e.start_date+"|"+e.name.normalize("NFKC").toLowerCase()+"|"+
        canonicalSourceUrl(e.source_url);
      bySource.set(k,[...(bySource.get(k)??[]),e.id]);
    }catch{/* legacy non-HTTPS URLs cannot be confidently reconciled */ }
  }
  let associated=0;
  for(const e of city){
    if(byCity.has(e.id))continue;
    const urls=sourceMap.get(e.id)??[];
    if(!urls.length)continue;
    const matched=new Set<string>();
    for(const url of urls){
      const k=e.start_date+"|"+e.name.normalize("NFKC").toLowerCase()+"|"+
        canonicalSourceUrl(url);
      for(const id of bySource.get(k)??[])matched.add(id);
    }
    // Multiple legacy rows are ambiguous; never guess which old UUID owns a plan.
    const id=matched.size===1?[...matched][0]:
      stableMessageId("ldi-city-cafe:"+businessId+":"+e.id);
    if(matched.size>1){
      // Ambiguous historical aliases require review, not a new competing row.
      console.warn("ldi_legacy_identity_ambiguous");
      continue;
    }
    if(matched.size===0){
      const inserted=await db.from("cafe_events").upsert({
        id,business_id:businessId,name:e.name,kind:e.kind,
        start_date:e.start_date,end_date:e.end_date,
        start_time:e.start_time,end_time:e.end_time,
        venue:e.venue,venue_address:e.venue_address,
        source_url:urls[0],status:"found",last_checked_at:e.last_checked_at,
      },{onConflict:"business_id,id",ignoreDuplicates:true});
      assertOk(inserted.error);
    }
    await linkCityEventToCafeEvent(db,{businessId,cafeEventId:id,cityEventId:e.id});
    associated++;
  }
  return associated;
}
/** The ONE scheduled job's A+B+C handoff; never called from Home or chat.
 * Returns null only when the additive schema is not yet deployed. */
export async function scanSharedResearch(db:Db,input:{
  businessId:string;location:CafeLocation;today:string;window:EventScanWindow;
  budget:LdiBudget;checkedAt:string;
}):Promise<{completed:boolean;through:string;reason:EventScanWindow["reason"];
  windowStart:string;associations:number}|null>{
  if(!await ldiSchemaReady(db))return null;
  const scope=cityScope(input.location);
  if(!scope)return null; // Cannot invent a city, region or country to satisfy A.
  const cityKey=cityScopeKey(scope);
  await neighborhood(db,input.businessId,input.location,scope,input.budget,input.checkedAt);
  const sources=await sourcesForCity(db,cityKey);
  let all=await allCoverage(db,cityKey);
  // Only root/source-slice rows determine completion. Saturation creates
  // child coverage records, but a child must never complete its parent.
  const older=all.filter(c=>c.is_scan_root&&!complete(c.status)&&
    c.scan_to>=addDays(input.today,-14)&&c.scan_from<=input.window.from)
    .sort((a,b)=>a.scan_from.localeCompare(b.scan_from)||
      a.scan_to.localeCompare(b.scan_to));
  const window:EventScanWindow=older.length?{
    from:older[0].scan_from,to:older[0].scan_to,reason:older[0].window_reason,
  }:input.window;

  // Do NOT lose new entering dates during an initial or weekly retry. Queue
  // one-day windows beyond the older scan's end; they remain retryable on disk.
  // Monday's requested full weekly range is queued independently, even when
  // an older partial day has priority.
  const toQueue:EventScanWindow[]=[];
  if(!older.length)toQueue.push(input.window);
  else{
    toQueue.push(window);
    if(input.window.reason==="weekly")toQueue.push(input.window);
    else{
      const beginning=addDays(window.to,1)>input.window.from?
        addDays(window.to,1):input.window.from;
      for(let day=beginning;day<=input.window.to;day=addDays(day,1))
        toQueue.push({from:day,to:day,reason:"new_day"});
    }
  }
  for(const proposed of toQueue){
    const intendedForWindow=sources.flatMap(source=>
      cityResearchDateSlices(proposed.from,proposed.to).map(slice=>({
        source,key:sourceKey(source),...slice,
      })));
    const needs=intendedForWindow.filter(item=>needsRefresh(
      matchingCoverage(all,item.key,item.from,item.to),
      proposed.reason,proposed.from));
    const missing=needs.filter(item=>!matchingCoverage(all,item.key,item.from,item.to));
    if(missing.length){
      const saved=await db.from("city_source_coverage").upsert(missing.map(item=>({
        city_key:cityKey,source_key:item.key,window_from:item.from,window_to:item.to,
        scan_from:proposed.from,scan_to:proposed.to,window_reason:proposed.reason,
        status:"partial",is_scan_root:true,search_attempted:false,
        last_checked_at:input.checkedAt,
      })),{onConflict:"city_key,source_key,window_from,window_to",ignoreDuplicates:true});
      assertOk(saved.error);
    }
    // A weekly recheck resets a previously completed source only ONCE. Its
    // stable epoch is Monday's original window.from, never Tuesday's retry date.
    const refresh=needs.filter(item=>{
      const prior=matchingCoverage(all,item.key,item.from,item.to);
      return prior&&complete(prior.status);
    });
    for(const item of refresh){
      const saved=await db.from("city_source_coverage").update({
        status:"partial",search_attempted:false,is_scan_root:true,
        scan_from:proposed.from,scan_to:proposed.to,window_reason:proposed.reason,
        last_checked_at:input.checkedAt,
      }).eq("city_key",cityKey).eq("source_key",item.key)
        .eq("window_from",item.from).eq("window_to",item.to);
      assertOk(saved.error);
    }
    all=await allCoverage(db,cityKey);
  }
  const intended=sources.flatMap(source=>cityResearchDateSlices(window.from,window.to)
    .map(slice=>({source,key:sourceKey(source),...slice})));
  all=await allCoverage(db,cityKey);
  const pending=intended.filter(item=>!complete(
    matchingCoverage(all,item.key,item.from,item.to)?.status??"partial"));
  const selected:typeof pending=[];
  for(const item of pending){
    const attemptKey=cityKey+"|"+item.key+"|"+item.from+"|"+item.to;
    if(input.budget.cityTasks<=0)break;
    if(input.budget.attempted.has(attemptKey))continue;
    input.budget.attempted.add(attemptKey);
    input.budget.cityTasks--;
    selected.push(item);
  }
  // Independent official calendars can be searched together. Each B adapter
  // still enforces <=3 paid HTTP attempts, three tasks at a time globally.
  for(let index=0;index<selected.length;index+=3){
    await Promise.all(selected.slice(index,index+3).map(async item=>{
      try{
        await studyOne(db,scope,item.source,item.from,item.to,
          window.reason,item.key,input.budget);
      }catch(error){
        console.warn("ldi_city_source_failed",{kind:item.source.kind,
          category:errorCode(error)||"research_or_store_failed"});
        // Queued partial status remains durable for a subsequent retry.
      }
    }));
  }
  all=await allCoverage(db,cityKey);
  const completed=intended.every(item=>{const row=matchingCoverage(all,item.key,item.from,item.to);
    return !!row&&row.is_scan_root&&complete(row.status);
  });
  const associations=await associateCityFacts(db,input.businessId,cityKey,window.from,window.to);
  return {completed,through:window.to,reason:window.reason,
    windowStart:window.from,associations};
}
