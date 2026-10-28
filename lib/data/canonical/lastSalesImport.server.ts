import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
/** Latest successfully committed SALES day, not a menu, roster or poll run. */
export async function lastSalesImportAt(db:SupabaseClient,businessId:string):Promise<string|null>{
 if(!z.uuid().safeParse(businessId).success)throw Error("invalid_business");
 const {data,error}=await db.from("toast_day_status")
  .select("imported_at").eq("business_id",businessId).eq("import_state","imported")
  .not("imported_at","is",null).order("imported_at",{ascending:false})
  .limit(1).maybeSingle();
 if(error)throw Error("sales_import_read_failed");
 return data?.imported_at??null;
}
