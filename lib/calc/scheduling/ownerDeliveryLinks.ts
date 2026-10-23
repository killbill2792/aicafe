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
  const lead={en:"Hi",es:"Hola",ar:"مرحبًا"}[locale];
  const header={en:"Here is your schedule for the week of",es:"Tu horario para la semana del",
    ar:"هذا جدول مناوباتك لأسبوع"}[locale];
  const close={en:"Please check your shifts.",es:"Por favor, revisa tus turnos.",
    ar:"يرجى مراجعة مناوباتك."}[locale];
  const lines=shifts.map(s=>`${s.date}: ${s.start}–${s.end}`);
  return `${lead} ${name},\n${header} ${week}:\n${lines.join("\n")}\n${close}`;
}
