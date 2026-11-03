import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

/** The one reader of which café menu categories are drinks (menu_category_labels).
 * Missing table or row means "not labeled yet", never "not a drink". */
export async function readMenuCategoryLabels(db:SupabaseClient,businessId:string):
 Promise<Map<string,boolean>>{
 if(!businessId)throw new Error("Café access scope mismatch");
 const {data,error}=await db.from("menu_category_labels").select("category,is_drink")
  .eq("business_id",businessId).limit(1000);
 if(error)return new Map();
 return new Map((data??[]).map(row=>[String(row.category),row.is_drink===true]));
}

/** Saves AI labels for categories that have none. Never overwrites a saved label,
 * so an owner correction always wins. Service role only (RLS). */
export async function saveAiMenuCategoryLabels(db:SupabaseClient,businessId:string,
 labels:readonly {category:string;isDrink:boolean}[]):Promise<void>{
 if(!businessId||!labels.length)return;
 const {error}=await db.from("menu_category_labels").upsert(
  labels.map(l=>({business_id:businessId,category:l.category,is_drink:l.isDrink,source:"ai"})),
  {onConflict:"business_id,category",ignoreDuplicates:true});
 if(error)throw new Error("menu_category_labels_unavailable");
}
