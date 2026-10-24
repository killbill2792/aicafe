import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {dateOffset} from "@/lib/calc/periods";
import {priceCheck,priceSource,realizedUnitAverage} from "@/lib/calc/menuPriceCheck";
export type MenuPriceEvidence={
 priceSource:"owner_manual"|"connected_pos"|"imported_avg"|"initial";
 realizedAvgCents:number|null;priceCheck:"ok"|"differs";
 pricePeriod:{from:string;to:string}|null;priceEvidenceStatus:"actual"|"partial"|"unknown";
};
/** Date-bounded, paged and tenant-scoped; never calculate an average from a truncated page. */
export async function readMenuPriceEvidence(businessId:string,
 items:ReadonlyArray<{id:string;priceCents:number}>,asOf:string):Promise<Record<string,MenuPriceEvidence>>{
 if(!items.length)return {};
 const db=await createServerSupabaseClient(),ids=items.map(x=>x.id);
 const [history,catalog,coverage]=await Promise.all([
  db.from("menu_price_history").select("menu_item_id,source_type,changed_at")
    .eq("business_id",businessId).in("menu_item_id",ids).order("changed_at",{ascending:false}),
  db.from("menu_items").select("id,catalog_source").eq("business_id",businessId).in("id",ids),
  db.from("daily_rollups").select("business_date").eq("business_id",businessId)
    .eq("sales_data_status","actual").lte("business_date",asOf)
    .order("business_date",{ascending:false}).limit(1).maybeSingle(),
 ]);
 if(history.error||catalog.error||coverage.error)throw new Error("Menu price evidence unavailable");
 const latest=new Map<string,string>();
 for(const row of history.data??[])if(!latest.has(row.menu_item_id))latest.set(row.menu_item_id,row.source_type);
 const sources=new Map((catalog.data??[]).map(row=>[row.id,row.catalog_source]));
 const to=coverage.data?.business_date??null;
 const period=to?{from:dateOffset(to,-29),to}:null;
 const rows:Array<{menu_item_id:string|null;net_sales_cents:number;quantity:number}>=[];
 let complete=Boolean(period);
 if(period){
  const PAGE=1000,MAX_PAGES=10;
  for(let page=0;page<MAX_PAGES;page++){
   const response=await db.from("order_lines")
     .select("id,menu_item_id,quantity,net_sales_cents,orders!inner(business_id,business_date)")
     .in("menu_item_id",ids).eq("orders.business_id",businessId)
     .gte("orders.business_date",period.from).lte("orders.business_date",period.to)
     .eq("voided",false).order("id",{ascending:true})
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
  results[item.id]={priceSource:priceSource(latest.get(item.id)??null,sources.get(item.id)??null),
    realizedAvgCents:avg,priceCheck:priceCheck(item.priceCents,avg),pricePeriod:period,
    priceEvidenceStatus:!complete?"partial":avg!==null?"actual":"unknown"};
 }
 return results;
}
