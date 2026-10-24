import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
export type MenuPriceEvidence={priceSource:"owner_manual"|"connected_pos"|"imported_avg"|"initial";realizedAvgCents:number|null;priceCheck:"ok"|"differs"};
export async function readMenuPriceEvidence(businessId:string,items:ReadonlyArray<{id:string;priceCents:number}>):Promise<Record<string,MenuPriceEvidence>>{
 if(!items.length)return {};
 const db=await createServerSupabaseClient();
 const ids=items.map(i=>i.id);
 const [history,lines]=await Promise.all([
  db.from("menu_price_history").select("menu_item_id,source_type,changed_at").eq("business_id",businessId).in("menu_item_id",ids).order("changed_at",{ascending:false}),
  db.from("order_lines").select("menu_item_id,quantity,net_sales_cents,orders!inner(business_id,business_date)").in("menu_item_id",ids).eq("orders.business_id",businessId).eq("voided",false).limit(30000),
 ]);
 if(history.error||lines.error)throw new Error("Menu evidence read failed");
 const latest=new Map<string,string>();for(const row of history.data??[])if(!latest.has(row.menu_item_id))latest.set(row.menu_item_id,row.source_type);
 const totals=new Map<string,{sales:number;units:number}>();
 for(const line of lines.data??[]){if(!line.menu_item_id)continue;const x=totals.get(line.menu_item_id)??{sales:0,units:0};x.sales+=Number(line.net_sales_cents);x.units+=Number(line.quantity);totals.set(line.menu_item_id,x);}
 const result:Record<string,MenuPriceEvidence>={};
 for(const item of items){
  const t=totals.get(item.id),avg=t&&t.units>0?Math.round(t.sales/t.units):null,src=latest.get(item.id);
  result[item.id]={priceSource:src==="owner_manual"?"owner_manual":src==="connected_pos"?"connected_pos":src==="imported"?"imported_avg":"initial",
   realizedAvgCents:avg,priceCheck:avg!==null&&avg>0&&Math.abs(item.priceCents-avg)>100&&Math.abs(item.priceCents-avg)/avg>0.25?"differs":"ok"};
 }
 return result;
}
