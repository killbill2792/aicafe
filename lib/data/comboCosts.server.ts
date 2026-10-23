import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ComboCostComponent} from "@/lib/calc/comboCostResolution";

/** Exact additive-schema compatibility only. All other errors fail closed, not as free food. */
export async function readMenuComboCostComponents(
 db:SupabaseClient,businessId:string,menuItemIds:readonly string[],
):Promise<ComboCostComponent[]>{
 if(!menuItemIds.length)return[];
 const {data,error,count}=await db.from("menu_combo_components")
  .select("combo_item_id,component_item_id,quantity,buy_in_cost_cents",{count:"exact"})
  .eq("business_id",businessId).in("combo_item_id",[...menuItemIds]);
 if(error?.code==="42P01"||error?.code==="PGRST205")return[];
 if(error||!data||count!==data.length)throw new Error("Could not load the full scoped menu combo composition");
 return data.map(row=>({
  comboItemId:row.combo_item_id,componentItemId:row.component_item_id,
  quantity:Number(row.quantity),buyInCostCents:row.buy_in_cost_cents===null?null:Number(row.buy_in_cost_cents),
 }));
}
