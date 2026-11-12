import "server-only";
import {formatInTimeZone} from "date-fns-tz";

export type OwnerNoticeKind="price_reminder"|"toast_price_initial"|
 "toast_price_daily"|"toast_price_final";
export type OwnerNoticeKey={
 businessId:string;ownerUserId:string;sourceId:string;
 kind:OwnerNoticeKind;localDate:string;slot:number;
};
export type ReminderReceipt=Pick<OwnerNoticeKey,"localDate"|"slot">;
const HOUR=3600000;
const safeInstant=(value:string)=>{
 const result=Date.parse(value);
 if(!Number.isFinite(result))throw new Error("invalid_notice_time");
 return result;
};
const localDay=(value:string,timezone:string)=>
 formatInTimeZone(new Date(safeInstant(value)),timezone,"yyyy-MM-dd");
/** Actual first reminder is approval+2 elapsed hours, regardless of DST.
 * A later local day gets a fresh cap, never an unlimited replay backlog. */
export function nextOwnerPriceReminder(input:{
 businessId:string;ownerUserId:string;proposalId:string;
 approvedAt:string;now:string;timezone:string;
 prior:readonly ReminderReceipt[];
 sourceVerified:boolean;cancelled:boolean;
}):OwnerNoticeKey|null{
 if(input.sourceVerified||input.cancelled)return null;
 const now=safeInstant(input.now),approved=safeInstant(input.approvedAt);
 if(now<approved+2*HOUR)return null;
 const date=localDay(input.now,input.timezone);
 const priorToday=input.prior.filter(r=>r.localDate===date);
 if(priorToday.length>=2)return null;
 const slot=priorToday.length+1;
 const lastLocalDay=localDay(input.approvedAt,input.timezone);
 // On the same café-local date, do not send two messages in the first 2h
 // after approval. The next reminder requires at least two more hours.
 if(date===lastLocalDay&&now<approved+(slot+1)*2*HOUR)return null;
 // A newer local day uses the first eligible existing cron tick; it must not
 // replay both missed daily slots on one run.
 if(priorToday.some(r=>r.slot===slot))return null;
 return {businessId:input.businessId,ownerUserId:input.ownerUserId,
  sourceId:input.proposalId,kind:"price_reminder",localDate:date,slot};
}
/** Independent Toast price changes are observation events, NOT experiments.
 * Window index is a durable stable key: no rerun can make a new notification. */
export function toastObservationNoticeKey(input:{
 businessId:string;ownerUserId:string;priceHistoryId:string;
 windowIndex:number;localDate:string;final?:boolean;
}):OwnerNoticeKey{
 const {windowIndex}=input;
 if(!Number.isSafeInteger(windowIndex)||windowIndex<0||windowIndex>7)
  throw new Error("invalid_toast_observation_index");
 return {businessId:input.businessId,ownerUserId:input.ownerUserId,
  sourceId:input.priceHistoryId,localDate:input.localDate,slot:0,
  kind:input.final?"toast_price_final":windowIndex===0?
   "toast_price_initial":"toast_price_daily"};
}
