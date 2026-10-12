import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { PosProvider } from "./types";

/** Square's completed, paginated closed-order search is authoritative only for
 * café-local dates covered from their midnight boundary. The current date can
 * be marked actual through the successful sync cutoff, not through day's end.
 * Other providers/imports never acquire zero coverage from this Square rule. */
export function squareCoveredSalesDates(params:{
  provider:PosProvider; since:Date; until:Date; timezone:string; now?:Date;
}):string[] {
  const {provider,since,until,timezone}=params;
  if(provider!=="square")return [];
  const now=params.now??new Date();
  const end=Math.min(until.getTime(),now.getTime()),start=since.getTime();
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return [];
  const first=formatInTimeZone(since,timezone,"yyyy-MM-dd");
  const last=formatInTimeZone(new Date(end-1),timezone,"yyyy-MM-dd");
  const today=formatInTimeZone(now,timezone,"yyyy-MM-dd");
  const covered:string[]=[];
  let day=first;
  for(let n=0;n<366 && day<=last;n++){
    const next=new Date(day+"T12:00:00Z");
    next.setUTCDate(next.getUTCDate()+1);
    const nextDay=next.toISOString().slice(0,10);
    const midnight=fromZonedTime(day+"T00:00:00",timezone).getTime();
    const nextMidnight=fromZonedTime(nextDay+"T00:00:00",timezone).getTime();
    if(start<=midnight && (end>=nextMidnight || (day===today&&end>midnight)))
      covered.push(day);
    day=nextDay;
  }
  return covered;
}
