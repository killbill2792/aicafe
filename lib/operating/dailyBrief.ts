import {createHash} from "node:crypto";
import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type BriefLocale="en"|"es"|"ar";
// When each café's brief goes out: lib/operating/briefSchedule.ts (per café, from its hours).
/** UUID-shaped and stable per café and day, so a repeated run cannot post twice. */
export function briefMessageId(businessId:string,day:string,ownerUserId?:string):string{
  const key="daily-brief:"+businessId+":"+day+(ownerUserId?":"+ownerUserId:"");
  const d=createHash("sha256").update(key).digest("hex");
  return d.slice(0,8)+"-"+d.slice(8,12)+"-4"+d.slice(13,16)+"-a"+d.slice(17,20)+"-"+d.slice(20,32);
}

/** The in-app brief's extra line, after the brief itself: yesterday's known costs
 * and what was kept (only when the snapshot's net sales match the brief's), and
 * how many things need the owner (only when that count could be read). */
export type BriefExtrasInput={
  locale:BriefLocale;currency:string|null;
  costs:{totalCostsCents:number;ownerProfitCents:number;complete:boolean}|null;
  /** null = the count could not be read: say nothing rather than "nothing needs you". */
  needsOwner:number|null;
};
export function briefExtras(i:BriefExtrasInput):string{
  const copy=({en,es,ar} as const)[i.locale].DailyBrief;
  const money=(c:number)=>formatCafeCurrency(c,i.locale,i.currency).text;
  const parts:string[]=[];
  if(i.costs){
    parts.push(copy.extrasCosts.replace("{costs}",money(i.costs.totalCostsCents))
      .replace("{kept}",money(i.costs.ownerProfitCents)));
    if(!i.costs.complete)parts.push(copy.partial);
  }
  if(i.needsOwner!==null)parts.push(i.needsOwner>0
    ?copy.needsYou.replace("{count}",new Intl.NumberFormat(i.locale).format(i.needsOwner)):copy.allClear);
  return parts.join(" ");
}
