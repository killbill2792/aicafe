import {addDays,weekdayOf} from "./holidays";
import type {NearbyEvent} from "./nearbyEvents";

/** Search completion is durable, including searches that returned no events. */
export type EventScanState={
  locationHash:string;scannedThroughDate:string;weeklyResearchedOn:string|null;
};
export type EventScanWindow={from:string;to:string;reason:"initial"|"weekly"|"new_day"};
/** Initial activation/address change covers all 14 days on ANY weekday.
 * The daily job adds one entering day; Monday separately researches the
 * whole saved window for late announcements. A rerun never pays twice. */
export function eventScanWindows(today:string,state:EventScanState|null,
  locationHash:string):EventScanWindow[]{
  const horizon=addDays(today,13);
  if(!state||state.locationHash!==locationHash)
    return [{from:today,to:horizon,reason:"initial"}];
  // The cursor may lag after bounded source retries or a temporarily disabled
  // cron. Catch up EVERY uncovered day rather than jumping to today's horizon.
  // Each B research window is at most 14 inclusive days.
  const missed:EventScanWindow[]=[];
  const missedEnd=weekdayOf(today)===1&&state.weeklyResearchedOn!==today
    ?addDays(today,-1):horizon;
  for(let from=addDays(state.scannedThroughDate,1);from<=missedEnd;){
    const to=addDays(from,13)<missedEnd?addDays(from,13):missedEnd;
    missed.push({from,to,reason:"new_day"});
    from=addDays(to,1);
  }
  if(weekdayOf(today)===1&&state.weeklyResearchedOn!==today)
    missed.push({from:today,to:horizon,reason:"weekly"});
  return missed;
}
/** Supporting table has only these factual kinds; never turn crowd guesses
 * into café advice, or write unrecognized provider enums. */
export function savedEventKind(kind:NearbyEvent["kind"]):string{
  if(["festival","conference","sports","parade","community"].includes(kind))return kind;
  return "other";
}
/** Stable scan key: source and original date identify an event. A moved event
 * gets a new ID and the old version may be marked moved after verification. */
export function eventIdentity(e:Pick<NearbyEvent,"name"|"startDate"|"sourceUrl"|"kind">):string{
  return [savedEventKind(e.kind),e.name.trim().toLowerCase(),e.startDate,e.sourceUrl].join("|");
}
