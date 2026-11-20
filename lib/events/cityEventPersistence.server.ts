import "server-only";
import {randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertDay,cityEventIdentity,cityPlaceIdentity,cityScopeKey,correctedSourceAlias,canonicalSourceUrl,
  type CityEventCandidate,type CityPlaceCandidate,type CityScope} from "./cityEventIdentity";

/** The ONLY planned writer for shared event/coverage/neighborhood storage.
 * E will invoke this on the existing lookahead job using a service-role client;
 * Home, chat, and authenticated browsers must never call these writes.
 * Reads in E/G still belong in lib/data/cafeEvents.server.ts. */
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function validId(value:string):string{
  if(!uuid.test(value))throw new Error("Invalid storage UUID");
  return value;
}
function validInstant(value:string):string{
  if(!value||Number.isNaN(Date.parse(value))||!/[zZ]|[+-]\d{2}:\d{2}$/u.test(value))
    throw new Error("Invalid observation time");
  return new Date(value).toISOString();
}
function persistedId(data:unknown):string{
  if(typeof data!=="string")throw new Error("Missing persisted identity");
  return validId(data);
}
function throwOnError(error:{message:string}|null){
  if(error)throw error;
}
export type CityEventWrite=CityEventCandidate&{checkedAt:string};
export type CityEventWriteResult={cityEventId:string;identityKey:string;cityKey:string};
export async function upsertCityEventFact(db:SupabaseClient,
  input:CityEventWrite):Promise<CityEventWriteResult>{
  const identity=cityEventIdentity(input);
  const {data,error}=await db.rpc("ldi_upsert_city_event",{
    p_city_key:identity.cityKey,p_identity_key:identity.identityKey,
    p_source_identity_key:identity.sourceIdentityKey,
    p_venue_identity_key:identity.venueIdentityKey,
    p_name:identity.name,p_kind:input.kind,p_start_date:identity.startDate,
    p_end_date:identity.endDate,p_source_url:identity.sourceUrl,
    p_checked_at:validInstant(input.checkedAt),p_venue:identity.venue,
    p_venue_address:identity.venueAddress,
    p_venue_key:identity.venueKey,p_venue_address_key:identity.venueAddressKey,
  });
  throwOnError(error);
  return {cityEventId:persistedId(data),identityKey:identity.identityKey,
    cityKey:identity.cityKey};
}
export type CityCoverageStatus="found"|"none_found"|"partial"|"failed";
export type CitySourceCoverageWrite=CityScope&{
  sourceKey:string;from:string;to:string;status:CityCoverageStatus;checkedAt:string;
};
export async function recordCitySourceCoverage(db:SupabaseClient,
  input:CitySourceCoverageWrite):Promise<void>{
  const cityKey=cityScopeKey(input);
  const sourceKey=input.sourceKey.trim();
  if(!sourceKey||sourceKey.length>240)throw new Error("Invalid coverage source");
  const from=assertDay(input.from),to=assertDay(input.to);
  if(to<from)throw new Error("Invalid coverage range");
  const {error}=await db.rpc("ldi_record_city_coverage",{
    p_city_key:cityKey,p_source_key:sourceKey,p_from:from,p_to:to,
    p_status:input.status,p_checked_at:validInstant(input.checkedAt),
  });
  throwOnError(error);
}
export type CafeNeighborhoodWrite=CityPlaceCandidate&{
  businessId:string;assessment:"potential"|"unlikely"|"unknown";
  rationale?:string|null;checkedAt:string;
};
export async function upsertCafeNeighborhoodEvidence(db:SupabaseClient,
  input:CafeNeighborhoodWrite):Promise<{placeId:string;cityKey:string}>{
  const identity=cityPlaceIdentity(input);
  if(input.rationale&&input.rationale.length>1200)throw new Error("Rationale too long");
  const {data,error}=await db.rpc("ldi_upsert_cafe_neighborhood",{
    p_business_id:validId(input.businessId),
    p_city_key:identity.cityKey,p_identity_key:identity.identityKey,
    p_name:identity.name,p_kind:input.kind,p_address:identity.address,
    p_source_url:identity.sourceUrl,p_calendar_url:identity.calendarUrl,
    p_checked_at:validInstant(input.checkedAt),p_assessment:input.assessment,
    p_rationale:input.rationale??null,
  });
  throwOnError(error);
  return {placeId:persistedId(data),cityKey:identity.cityKey};
}
/** Existing cafe_events UUID is a required input, not an ID to regenerate.
 * The DB rejects a second identity for that legacy row, or a second legacy row
 * for the same city event in one cafe. Does not touch cafe_events/proposals. */
export async function linkCityEventToCafeEvent(db:SupabaseClient,input:{
  businessId:string;cafeEventId:string;cityEventId:string;
}):Promise<string>{
  const {data,error}=await db.rpc("ldi_link_cafe_event",{
    p_business_id:validId(input.businessId),
    p_cafe_event_id:validId(input.cafeEventId),
    p_city_event_id:validId(input.cityEventId),
  });
  throwOnError(error);
  return persistedId(data);
}
/** E should look up an existing association BEFORE creating a new cafe_event,
 * especially while staging legacy backfill. Missing means unlinked, not absent. */
export async function findCafeEventIdForCityEvent(db:SupabaseClient,input:{
  businessId:string;cityEventId:string;
}):Promise<string|null>{
  const {data,error}=await db.from("cafe_city_event_links").select("cafe_event_id")
    .eq("business_id",validId(input.businessId))
    .eq("city_event_id",validId(input.cityEventId)).maybeSingle();
  throwOnError(error);
  return data?.cafe_event_id?validId(data.cafe_event_id):null;
}

/** Source-backed change to a known shared occurrence, using its exact claimed
 * café association rather than matching a similar event by name. */
export async function correctCityOccurrence(db:SupabaseClient,businessId:string,
 event:import("@/lib/data/cafeEvents.server").CafeEvent,
 change:import("./eventVerification").VerifiedChange,claimAt:string){
 if(!event.cityEventId||!event.cityKey||!event.sourceUrl)throw new Error("occurrence_identity_unavailable");
 const newDate=change.newEndDate?change.newDate:null;
 const sourceUrls=[...new Set([event.sourceUrl,...(event.sourceUrls??[])])];
 const aliases=newDate?sourceUrls.map(url=>correctedSourceAlias(event.cityKey!,event.name,newDate,url)):[];
 const {data,error}=await db.rpc("ldi_correct_occurrence",{
   p_business_id:validId(businessId),p_cafe_event_id:validId(event.id),p_city_id:validId(event.cityEventId),
   p_claim_at:validInstant(claimAt),p_change:{...change,originalSourceUrl:canonicalSourceUrl(event.sourceUrl)},
   p_aliases:aliases,
 });
 throwOnError(error);return data===true;
}

/** Existing handled-task ledger, claimed before paid assessment/change work.
 * Retry failed versions, but never regenerate a completed identical version. */
export async function withEventWorkClaim<T>(db:SupabaseClient,businessId:string,ownerId:string,
 type:"assessment"|"change",key:string,day:string,work:(complete:()=>void)=>Promise<T>):Promise<T|null>{
 const token=randomUUID(),workKey="event-work:"+type+":"+key;
 const claimed=await db.rpc("ldi_claim_event_work",{p_business_id:businessId,p_owner_id:ownerId,
   p_work_key:workKey,p_day:day,p_token:token});
 throwOnError(claimed.error);
 if(claimed.data!==true)return null;
 let complete=false;
 try{return await work(()=>{complete=true;});}finally{
   const released=await db.rpc("ldi_release_event_work",{p_business_id:businessId,p_work_key:workKey,
     p_token:token,p_complete:complete});
   throwOnError(released.error);
 }
}
