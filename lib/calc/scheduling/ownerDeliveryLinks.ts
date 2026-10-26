import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
/** External compose only. These links do not send or confirm delivery. */
export type OwnerChannel="whatsapp"|"sms";
export const validE164=(phone:string|null|undefined):phone is string=>
  typeof phone==="string"&&/^\+[1-9][0-9]{1,14}$/.test(phone);
export function composeScheduleLink(phone:string,message:string,channel:OwnerChannel,isIOS=false){
  if(!validE164(phone)||!message.trim())throw new Error("invalid_recipient_or_message");
  const body=encodeURIComponent(message);
  return channel==="whatsapp"
    ?`https://wa.me/${phone.slice(1)}?text=${body}`
    :`sms:${phone}${isIOS?"&":"?"}body=${body}`;
}
export function eligibleForChannel(phone:string|null,optedIn:boolean,channel:OwnerChannel):
 "ready"|"no_phone"|"not_opted_in" {
 if(!validE164(phone))return "no_phone";
 if(channel==="whatsapp"&&!optedIn)return "not_opted_in";
 return "ready";
}
export type ShiftForMessage={date:string;start:string;end:string};
export function buildScheduleMessage(locale:"en"|"es"|"ar",name:string,week:string,shifts:ShiftForMessage[]){
  const copy={en:en.OwnerScheduleDelivery,es:es.OwnerScheduleDelivery,ar:ar.OwnerScheduleDelivery}[locale];
  const greeting=copy.messageGreeting.replace("{name}",name);
  const header=copy.messageWeek.replace("{week}",week);
  const lines=shifts.map(s=>`${s.date}: ${s.start}–${s.end}`);
  return [greeting,header,...lines,copy.messageClosing].join("\n");
}
