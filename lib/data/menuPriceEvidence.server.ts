import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {dateOffset} from "@/lib/calc/periods";
import {priceCheck,priceSource,realizedUnitAverage,type PriceCheck,type PriceEvidenceStatus} from "@/lib/calc/menuPriceCheck";
import type {MenuCatalogRow} from "./menuCatalog.server";
export type MenuPriceEvidence={
 priceSource:"owner_manual"|"connected_pos"|"imported_avg"|"initial";
 realizedAvgCents:number|null;priceCheck:PriceCheck;
 pricePeriod:{from:string;to:string}|null;priceEvidenceStatus:PriceEvidenceStatus;
};
/** Date-bounded, paged and tenant-scoped; never calculate an average from a truncated page. */
export async function readMenuPriceEvidence(businessId:string,
 items:ReadonlyArray<{id:string;priceCents:number}>,asOf:string,scopedClient?:SupabaseClient):Promise<Record<string,MenuPriceEvidence>>{
 if(!items.length)return {};
 const db=scopedClient??await createServerSupabaseClient(),ids=items.map(x=>x.id);
 const [history,catalog,coverage]=await Promise.all([
  db.from("menu_price_history").select("menu_item_id,source_type,changed_at")
    .eq("business_id",businessId).in("menu_item_id",ids).order("changed_at",{ascending:false}),
  db.rpc("menu_catalog_for",{p_business_id:businessId}).select("id,catalog_source").in("id",ids),
  db.from("cv_sales_days").select("business_date").eq("business_id",businessId)
    .eq("data->>sales_data_status","actual").lte("business_date",asOf)
    .order("business_date",{ascending:false}).limit(1).maybeSingle(),
 ]);
 if(history.error||catalog.error||coverage.error)throw new Error("Menu price evidence unavailable");
 const latest=new Map<string,string>();
 for(const row of history.data??[])if(!latest.has(row.menu_item_id))latest.set(row.menu_item_id,row.source_type);
 const catalogRows=(catalog.data??[]) as Pick<MenuCatalogRow,"id"|"catalog_source">[];
 const sources=new Map(catalogRows.map(row=>[row.id,row.catalog_source]));
 const to=coverage.data?.business_date??null;
 const period=to?{from:dateOffset(to,-29),to}:null;
 const rows:Array<{menu_item_id:string|null;net_sales_cents:number;quantity:number}>=[];
 let complete=Boolean(period);
 if(period){
  const PAGE=1000,MAX_PAGES=10;
  for(let page=0;page<MAX_PAGES;page++){
   const response=await db.from("cv_item_sales_daily")
     .select("menu_item_id,quantity,net_sales_cents")
     .in("menu_item_id",ids).eq("business_id",businessId).eq("status","actual")
     .gte("business_date",period.from).lte("business_date",period.to)
     .order("source_ref",{ascending:true})
     .range(page*PAGE,(page+1)*PAGE-1);
   if(response.error)throw new Error("Menu realized sales read unavailable");
   for(const row of response.data??[])rows.push({menu_item_id:row.menu_item_id,
     quantity:Number(row.quantity),net_sales_cents:Number(row.net_sales_cents)});
   if((response.data??[]).length<PAGE)break;
   if(page===MAX_PAGES-1)complete=false;
  }
 }
 const results:Record<string,MenuPriceEvidence>={};
 for(const item of items){
  const found=complete?rows.filter(row=>row.menu_item_id===item.id):[];
  const avg=complete?realizedUnitAverage(found):null;
  const status:PriceEvidenceStatus=!complete?"partial":avg!==null?"actual":"unknown";
  results[item.id]={priceSource:priceSource(latest.get(item.id)??null,sources.get(item.id)??null),
    realizedAvgCents:avg,priceCheck:priceCheck(item.priceCents,avg,status),pricePeriod:period,
    priceEvidenceStatus:status};
 }
 return results;
}
