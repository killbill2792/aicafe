import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readCompletePaged} from "./completePages";
import type {ComboCostComponent} from "@/lib/calc/comboCostResolution";

/** Exact additive-schema compatibility only. All other errors fail closed, not as free food. */
export async function readMenuComboCostComponents(
 db:SupabaseClient,businessId:string,menuItemIds:readonly string[],
):Promise<ComboCostComponent[]>{
 if(!menuItemIds.length)return[];
 const rows:Array<{combo_item_id:string;component_item_id:string;
   quantity:number|string;buy_in_cost_cents:number|string|null}>=[];
 for(let i=0;i<menuItemIds.length;i+=100){
  const batch=menuItemIds.slice(i,i+100);
  try{
   const data=await readCompletePaged((start,end)=>db.from("menu_combo_components")
    .select("combo_item_id,component_item_id,quantity,buy_in_cost_cents",{count:"exact"})
    .eq("business_id",businessId).in("combo_item_id",[...batch])
    .order("combo_item_id",{ascending:true}).order("component_item_id",{ascending:true})
    .range(start,end),row=>row.combo_item_id+":"+row.component_item_id);
   if(data===null)throw new Error("Incomplete menu combo source pages");
   rows.push(...data);
  }catch(error){
   // Preserve the exact additive-schema compatibility contract only when
   // the table is absent; do not reclassify other errors as absent/free costs.
   if(error&&typeof error==="object"&&"code" in error&&
      (error.code==="42P01"||error.code==="PGRST205"))return[];
   throw new Error("Could not load the full scoped menu combo composition");
  }
 }
 return rows.map(row=>({
  comboItemId:row.combo_item_id,componentItemId:row.component_item_id,
  quantity:Number(row.quantity),buyInCostCents:row.buy_in_cost_cents===null?null:Number(row.buy_in_cost_cents),
 }));
}
