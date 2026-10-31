import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readDailyFactRows} from "@/lib/data/dailyFacts.server";
import {readPeriodItemSales} from "@/lib/data/periodItemSales.server";
import {readMenuCatalogRows} from "@/lib/data/menuCatalog.server";
import {readCafeEvents} from "@/lib/data/cafeEvents.server";
import {readOwnerProposals} from "@/lib/ai/supervisor/loop/reads.server";
import {prepareMorningBrief,type PreparedMorningBrief} from "./morningBrief";
import {briefDue} from "@/lib/operating/dailyBrief";

export type MorningBriefRecipient={
  businessId:string;ownerUserId:string;businessName:string;currency:string|null;
  timezone:string;
  today:string;yesterday:string;
  /** A's binding/outbox adapter must verify both before calling this reader. */
  verifiedBinding:boolean;followupPermitted:boolean;
};

/** A read-only adapter for PR A's future verified-recipient outbox.
 * Do not call the provider here; A owns opt-in, dedupe and delivery.
 * Missing sources and failed monitor eligibility simply make this channel ineligible. */
export async function readPreparedMorningBrief(db:SupabaseClient,recipient:MorningBriefRecipient,
  now:Date):Promise<PreparedMorningBrief|null>{
  if(!recipient.verifiedBinding||!recipient.followupPermitted)return null;
  // A message for a different UTC day (or an invalid IANA zone) cannot be
  // made eligible by a caller supplying an arbitrary day or stale binding.
  let local:{due:boolean;today:string;yesterday:string};
  try{local=briefDue(now,recipient.timezone);}catch{return null;}
  if(!local.due||local.today!==recipient.today||local.yesterday!==recipient.yesterday)return null;
  const day={from:recipient.yesterday,to:recipient.yesterday};
  const [daily,items,menu,events,monitors]=await Promise.all([
    readDailyFactRows(db,recipient.businessId,day.from,day.to),
    readPeriodItemSales(db,recipient.businessId,day),
    readMenuCatalogRows(db,recipient.businessId),
    readCafeEvents(db,recipient.businessId,recipient.today,recipient.today),
    readOwnerProposals(db,{businessId:recipient.businessId,ownerUserId:recipient.ownerUserId},
      {statuses:["committed","manual_confirmed"],limit:100}),
  ]);
  const sales=daily.length===1&&daily[0].business_date===recipient.yesterday?daily[0]:null;
  return prepareMorningBrief({
    businessId:recipient.businessId,businessName:recipient.businessName,currency:recipient.currency,
    today:recipient.today,yesterday:recipient.yesterday,
    salesStatus:sales?.sales_data_status??null,
    netSalesCents:sales?.net_sales_cents??null,
    itemCoverage:items.covered,soldItems:items.soldItems,
    menu:menu.map(m=>({id:m.id,name:m.name,base_name:m.base_name,category:m.category})),
    savedEvents:events,monitors,
    verifiedBinding:recipient.verifiedBinding,followupPermitted:recipient.followupPermitted,
  },now);
}
