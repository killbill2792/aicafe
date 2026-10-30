import type {CafeEvent} from "@/lib/data/cafeEvents.server";

export type EventVerdict="confirmed"|"cancelled"|"postponed"|"venue_changed"|"reinstated"|"conflicting"|"unverified";
export type EventEvidence={
  verdict:EventVerdict;sourceUrl:string|null;statement:string|null;
  newDate:string|null;newVenue:string|null;
};
export type VerifiedChange={
  id:string;previousStatus:CafeEvent["status"];status:CafeEvent["status"];
  verdict:EventVerdict;sourceUrl:string;statement:string;
  newDate:string|null;newVenue:string|null;verifiedAt:string;
};
const safeUrl=(value:string)=>{
  try{
    const url=new URL(value);
    return url.protocol==="https:"?url:null;
  }catch{return null;}
};
const canonical=(value:string)=>value.replace(/\/$/u,"").replace(/#.*$/u,"");

/** Search omission is never proof. Only a cited page from the saved source's host
 * can change a known event's status; a positive "confirmed" can't reinstate it. */
export function credibleEventEvidence(event:CafeEvent,evidence:EventEvidence,
  citedUrls:readonly string[]):boolean{
  if(!event.sourceUrl||!evidence.sourceUrl||!evidence.statement?.trim()||
    evidence.statement.length>500)return false;
  const original=safeUrl(event.sourceUrl),source=safeUrl(evidence.sourceUrl);
  return !!original&&!!source&&original.hostname.replace(/^www\./u,"")===
    source.hostname.replace(/^www\./u,"")&&
    citedUrls.some(url=>canonical(url)===canonical(evidence.sourceUrl!));
}
export function verifiedEventChange(event:CafeEvent,evidence:EventEvidence,
  citedUrls:readonly string[],at:string):VerifiedChange|null{
  if(!credibleEventEvidence(event,evidence,citedUrls))return null;
  const status:CafeEvent["status"]=
    evidence.verdict==="cancelled"?"cancelled":
    evidence.verdict==="postponed"||evidence.verdict==="venue_changed"?"moved":
    evidence.verdict==="reinstated"?"found":event.status;
  if(!["cancelled","postponed","venue_changed","reinstated"].includes(evidence.verdict)||
    (evidence.verdict==="reinstated"&&event.status==="found")||
    (status===event.status&&evidence.verdict!=="venue_changed"&&
      evidence.verdict!=="postponed"))return null;
  return {id:event.id,previousStatus:event.status,status,
    verdict:evidence.verdict,sourceUrl:evidence.sourceUrl,
    statement:evidence.statement.trim(),newDate:evidence.newDate,
    newVenue:evidence.newVenue,verifiedAt:at};
}
export function eventVerificationDue(event:CafeEvent,today:string,now:Date):boolean{
  if(event.kind==="holiday"||!event.sourceUrl?.startsWith("https://")||
    event.endDate<today)return false;
  const days=(Date.parse(event.startDate+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000;
  if(days>13)return false;
  const attempt=event.lastAttemptedAt?Date.parse(event.lastAttemptedAt):NaN;
  // Daily source checks, even well before the first preparation or ordering decision.
  const gapMs=20*3600000;
  return !Number.isFinite(attempt)||now.getTime()-attempt>=gapMs;
}
export function importantVerificationQueue(events:readonly CafeEvent[],
  plans:readonly {startDate:string;endDate:string;status:string}[],
  today:string,now:Date,limit=3):CafeEvent[]{
  return events.filter(e=>plans.some(p=>p.status!=="rejected"&&p.status!=="expired"&&
    p.startDate<=e.endDate&&p.endDate>=e.startDate)&&
    eventVerificationDue(e,today,now))
    // With a bounded daily budget, prioritize never-checked / oldest attempts,
    // otherwise crowded calendars can starve later events forever.
    .sort((a,b)=>(a.lastAttemptedAt??"").localeCompare(b.lastAttemptedAt??"")||
      a.startDate.localeCompare(b.startDate)||a.id.localeCompare(b.id))
    .slice(0,limit);
}
