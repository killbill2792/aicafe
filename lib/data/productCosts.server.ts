import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {ProductCostSource,RecipeCostStatus} from "@/lib/calc";
import {readCompletePaged} from "./completePages";

export type CanonicalProductCost={
 costCents:number|null;status:RecipeCostStatus;source:ProductCostSource|null;estimated:boolean;
 recipe:Array<{ingredientId:string;ingredientName:string|null;baseUnit:"g"|"ml"|"each"|null;starterKey:string|null;
 quantity:number;displayUnit:string|null;displayQuantity:number|null;sortOrder:number|null;costCents:number|null;
 priceSource:"manual"|"receipt"|"statement"|"invoice"|null}>;
 recipeStatus:RecipeCostStatus;recipeCostCents:number|null;ownerTotalCostCents:number|null;
 ownerTotalCostStatus:"confirmed"|"estimated"|null;ownerTotalCostSource:"owner_manual"|"imported"|null;differenceCents:number|null;
};

/** All saved items, including archived combo components; one scoped SQL calculator.
 * The explicit date is a price valuation only, not proof of past composition. */
export async function readProductCosts(db:SupabaseClient,businessId:string,itemIds:readonly string[],asOf?:string):Promise<Map<string,CanonicalProductCost>>{
 if(!itemIds.length)return new Map();
 const rows=await readCompletePaged((start,end)=>{
   const q=asOf?db.rpc("product_costs_as_of",{p_business_id:businessId,p_as_of:asOf},{count:"exact"}):
     db.from("cv_menu_product_costs").select("menu_item_id,data",{count:"exact"}).eq("business_id",businessId);
   return q.order("menu_item_id",{ascending:true}).range(start,end) as unknown as PromiseLike<{data:Array<{menu_item_id:string;data:CanonicalProductCost}>|null;error:unknown;count:number|null}>;
 },row=>row.menu_item_id);
 if(rows===null)throw Error("product_cost_source_incomplete");
 const out=new Map(rows.map(r=>[r.menu_item_id,r.data]));
 for(const id of itemIds){
   const c=out.get(id);
   if(!c||!["READY","NO_RECIPE","MISSING_INGREDIENT_COST"].includes(c.status)||
     (c.costCents!==null&&!Number.isFinite(c.costCents))||!Array.isArray(c.recipe))
     throw Error("product_cost_source_incomplete");
 }
 return out;
}
