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

export type BriefInput={
  /** Yesterday from the same reader as the chat's profit answer; null when it had no sales data. */
  yesterday:{netSalesCents:number;totalCostsCents:number;ownerProfitCents:number;complete:boolean}|null;
  needsOwner:number;currency:string|null;locale:BriefLocale;
  verifiedNetSalesCents?:number|null;
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
    :i.verifiedNetSalesCents!==null&&i.verifiedNetSalesCents!==undefined
      ?copy.netOnly.replace("{sales}",money(i.verifiedNetSalesCents)) :copy.noSales];
  if(currencyMissing)parts.push(copy.currencyMissing);
  parts.push(i.needsOwner>0?copy.needsYou.replace("{count}",count(i.needsOwner)):copy.allClear);
  return parts.join(" ");
}
