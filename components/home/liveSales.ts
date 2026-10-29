/** How Home shows the saved live Toast reading for Today. Fresh means the
 * 15-minute job or the chat read Toast in the last 30 minutes; a reading older
 * than 12 hours belongs to an earlier day and is not shown. */
export const LIVE_FRESH_MS=30*60_000;
const LIVE_MAX_MS=12*60*60_000;
export function liveSalesView(live:{value:{netSalesCents:number;readAt:string};ageMs:number}|null,
 timezone:string|null,locale:string):{netSalesCents:number;time:string;fresh:boolean}|null{
 if(!live||live.ageMs>LIVE_MAX_MS)return null;
 const time=new Intl.DateTimeFormat(locale,{hour:"numeric",minute:"2-digit",
  ...(timezone?{timeZone:timezone}:{})}).format(new Date(live.value.readAt));
 return {netSalesCents:live.value.netSalesCents,time,fresh:live.ageMs<LIVE_FRESH_MS};
}
