import {createHash} from "node:crypto";
import {addCalendarDays,localClock} from "@/lib/pos/toast/scheduleDates";
import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type BriefLocale="en"|"es"|"ar";
/** The brief goes out once per café per day, in the café's morning. */
export const BRIEF_FROM_HOUR=8,BRIEF_UNTIL_HOUR=12;

export function briefDue(now:Date,timezone:string):{due:boolean;today:string;yesterday:string}{
  const c=localClock(now,timezone);
  return {due:c.minutes>=BRIEF_FROM_HOUR*60&&c.minutes<BRIEF_UNTIL_HOUR*60,today:c.today,
    yesterday:addCalendarDays(c.today,-1)};
}
/** UUID-shaped and stable per café and day, so a repeated run cannot post twice. */
export function briefMessageId(businessId:string,day:string):string{
  const d=createHash("sha256").update("daily-brief:"+businessId+":"+day).digest("hex");
  return d.slice(0,8)+"-"+d.slice(8,12)+"-4"+d.slice(13,16)+"-a"+d.slice(17,20)+"-"+d.slice(20,32);
}

export type BriefInput={
  /** Yesterday from the same reader as the chat's profit answer; null when it had no sales data. */
  yesterday:{netSalesCents:number;totalCostsCents:number;ownerProfitCents:number;complete:boolean}|null;
  needsOwner:number;currency:string|null;locale:BriefLocale;
};
export function briefText(i:BriefInput):string{
  const copy=({en,es,ar} as const)[i.locale].DailyBrief;
  let currencyMissing=false;
  const money=(c:number)=>{const f=formatCafeCurrency(c,i.locale,i.currency);
    if(f.currencyMissing)currencyMissing=true;return f.text;};
  const count=(n:number)=>new Intl.NumberFormat(i.locale).format(n);
  const parts=[i.yesterday
    ?copy.yesterday.replace("{sales}",money(i.yesterday.netSalesCents))
      .replace("{costs}",money(i.yesterday.totalCostsCents)).replace("{kept}",money(i.yesterday.ownerProfitCents))
      +(i.yesterday.complete?"":" "+copy.partial)
    :copy.noSales];
  if(currencyMissing)parts.push(copy.currencyMissing);
  parts.push(i.needsOwner>0?copy.needsYou.replace("{count}",count(i.needsOwner)):copy.allClear);
  return parts.join(" ");
}
