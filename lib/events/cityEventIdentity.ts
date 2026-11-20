import {createHash} from "node:crypto";

/** Pure, deterministic public identity; NEVER includes a cafe ID or owner data. */
export type CityScope={city:string;region:string;countryCode:string};
export type CityEventKind="holiday"|"festival"|"conference"|"sports"|"parade"|"community"|"other";
export type CityPlaceKind="office"|"university"|"convention"|"medical"|"transit"|"hotel"|"entertainment"|"other";
export type CityEventCandidate=CityScope&{
  name:string;startDate:string;endDate?:string|null;kind:CityEventKind;
  sourceUrl:string;venue?:string|null;venueAddress?:string|null;
};
export type CityPlaceCandidate=CityScope&{
  name:string;kind:CityPlaceKind;address?:string|null;sourceUrl:string;
  calendarUrl?:string|null;
};
const digest=(text:string)=>createHash("sha256").update(text,"utf8").digest("hex");
const clean=(text:string)=>text.normalize("NFKD").replace(/\p{M}/gu,"")
  .toLocaleLowerCase("en").replace(/&/gu," and ")
  .replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/gu," ");
/** One canonical event-name key, shared by A's public identity and E's
 * legacy café association. Keeps original UUIDs, cancellations and reports
 * intact across accents, punctuation and &/and variants. */
export const canonicalEventNameKey=(name:string):string=>clean(name);
const nonblank=(value:string,max:number,field:string)=>{
  if(!value||!value.trim()||value.length>max)throw new Error("Invalid "+field);
  return value.trim();
};
export function assertDay(day:string):string{
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(day)||
     !Number.isFinite(Date.parse(day+"T00:00:00Z"))||
     new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day)
    throw new Error("Invalid event day");
  return day;
}
export function cityScopeKey(scope:CityScope):string{
  const country=nonblank(scope.countryCode,2,"country code").toUpperCase();
  if(!/^[A-Z]{2}$/u.test(country))throw new Error("Invalid country code");
  const region=clean(nonblank(scope.region,100,"region"));
  const city=clean(nonblank(scope.city,150,"city"));
  if(!region||!city)throw new Error("Invalid city scope");
  const result=[country.toLowerCase(),region,city].join("|");
  if(result.length>240)throw new Error("City key too long");
  return result;
}
/** Strip tracking but keep event-identifying query parameters. No opaque URLs. */
export function canonicalSourceUrl(raw:string):string{
  const url=new URL(nonblank(raw,2000,"source URL"));
  if(url.protocol!=="https:"||url.username||url.password)throw new Error("Source must be an HTTPS URL");
  url.hash="";
  for(const key of [...url.searchParams.keys()])
    if(/^utm_/iu.test(key)||["fbclid","gclid","mc_cid","mc_eid"].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname=url.pathname.replace(/\/+$/u,"")||"/";
  const result=url.toString();
  if(result.length>2000)throw new Error("Source URL too long");
  return result;
}
function label(value:string,max:number,field:string){
  const result=nonblank(value,max,field);
  if(!clean(result))throw new Error("Invalid "+field);
  return result;
}
export function cityEventIdentity(input:CityEventCandidate){
  const cityKey=cityScopeKey(input);
  const name=label(input.name,200,"event name");
  const nameKey=clean(name);
  const startDate=assertDay(input.startDate);
  const endDate=assertDay(input.endDate??input.startDate);
  if(endDate<startDate)throw new Error("Event end precedes start");
  const venue=input.venue?label(input.venue,200,"venue"):null;
  const venueAddress=input.venueAddress?label(input.venueAddress,500,"venue address"):null;
  const sourceUrl=canonicalSourceUrl(input.sourceUrl);
  const venueKey=venue?clean(venue):null;
  const venueAddressKey=venueAddress?clean(venueAddress):null;
  // This source anchor never changes as a listing becomes more detailed.
  const sourceIdentityKey=digest([cityKey,startDate,nameKey,
    "source:"+sourceUrl].join("\u001f"));
  // Strong cross-source reconciliation requires BOTH a named venue and its
  // address. Distinct halls at the SAME address are not interchangeable.
  // Unknown or incomplete venues stay source-scoped until corroborated.
  const venueIdentityKey=venue&&venueAddress?digest([cityKey,startDate,nameKey,
    "venue:"+venueKey,"address:"+venueAddressKey].join("\u001f")):null;
  return {cityKey,name,nameKey,startDate,endDate,venue,venueAddress,
    venueKey,venueAddressKey,sourceUrl,sourceIdentityKey,venueIdentityKey,
    identityKey:venueIdentityKey??sourceIdentityKey};
}
export function cityPlaceIdentity(input:CityPlaceCandidate){
  const cityKey=cityScopeKey(input);
  const name=label(input.name,200,"place name");
  const address=input.address?label(input.address,500,"place address"):null;
  const sourceUrl=canonicalSourceUrl(input.sourceUrl);
  const calendarUrl=input.calendarUrl?canonicalSourceUrl(input.calendarUrl):null;
  const discriminator=address?"address:"+clean(address):"source:"+sourceUrl;
  return {cityKey,name,address,sourceUrl,calendarUrl,
    identityKey:digest([cityKey,clean(name),discriminator].join("\u001f"))};
}

/** A verified correction may register a new dated alias for the SAME UUID.
 * Discovery still distinguishes recurring editions by their date. */
export function correctedSourceAlias(cityKey:string,name:string,date:string,source:string){
 return digest([cityKey,assertDay(date),canonicalEventNameKey(name),"source:"+canonicalSourceUrl(source)].join("\u001f"));
}

/** Explicit offset + named IANA zone disambiguates DST folds and gaps. A
 * midnight endpoint is exclusive, not a fictitious next-day occurrence. */
export function projectTimedOccurrence(startAt:string,endAt:string,timezone:string){
 const iso=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
 if(!iso.test(startAt)||!iso.test(endAt))throw Error("explicit_event_offset_required");
 assertDay(startAt.slice(0,10));assertDay(endAt.slice(0,10));
 const start=Date.parse(startAt),end=Date.parse(endAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error("invalid_event_interval");
 const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
 const parts=(ms:number)=>Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
 const day=(p:Record<string,string>)=>p.year+"-"+p.month+"-"+p.day;
 const time=(p:Record<string,string>)=>p.hour+":"+p.minute;
 return {startDate:day(parts(start)),endDate:day(parts(end-1)),startTime:time(parts(start)),endTime:time(parts(end))};
}
export function verifiedTimedOccurrence(startAt:string,endAt:string,timezone:string){
 const window=projectTimedOccurrence(startAt,endAt,timezone);
 const endWall=projectTimedOccurrence(endAt,new Date(Date.parse(endAt)+60000).toISOString(),timezone);
 if(window.startDate+"T"+window.startTime!==startAt.slice(0,16)||endWall.startDate+"T"+endWall.startTime!==endAt.slice(0,16))
   throw Error("event_timezone_offset_conflict");
 return {startAt:new Date(startAt).toISOString(),endAt:new Date(endAt).toISOString(),sourceTimezone:timezone,...window};
}
