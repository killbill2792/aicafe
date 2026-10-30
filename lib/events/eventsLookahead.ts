import {addDays,weekdayOf} from "./holidays";
import type {NearbyEvent} from "./nearbyEvents";

/** Monday refreshes the whole two-week window. Other days only search the
 * newly entering day and recheck tomorrow for a confirmed change. */
export type EventScanWindow={from:string;to:string;reason:"weekly"|"new_day"|"day_before"};
export function eventScanWindows(today:string):EventScanWindow[]{
  const next=addDays(today,1);
  return weekdayOf(today)===1
    ?[{from:today,to:addDays(today,6),reason:"weekly"},
      {from:addDays(today,7),to:addDays(today,13),reason:"weekly"},
      {from:next,to:next,reason:"day_before"}]
    :[{from:addDays(today,13),to:addDays(today,13),reason:"new_day"},
      {from:next,to:next,reason:"day_before"}];
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
