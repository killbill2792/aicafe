import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {Ingredient,SupplierQuote} from "@/lib/purchasing/planOrder";

/** The sole purchasing evidence reader. Café identity and owner membership are
 * validated by simulationOwnerReader before this function is called. Never
 * turn old, currency-less quotes into current-currency offers. */
export async function readSupplierPurchasingEvidence(db:SupabaseClient,businessId:string){
 const [ingredients,quotes,business]=await Promise.all([
  db.from("ingredients").select("id,name,base_unit").eq("business_id",businessId)
    .is("archived_at",null).order("name").limit(2000),
  db.from("ai_supplier_quotes").select("id,supplier_name,item_name,ingredient_id,price_cents,"+
    "package_count,package_unit,currency_code,source_kind,quoted_on,valid_until,"+
    "available_status,available_checked_at,delivery_on")
    .eq("business_id",businessId).order("created_at",{ascending:false}).limit(501),
  db.from("businesses").select("currency,timezone").eq("id",businessId).maybeSingle(),
 ]);
 if(ingredients.error||quotes.error||business.error||!business.data)
  throw new Error("supplier_purchase_evidence_unavailable");
 if((ingredients.data??[]).length===2000)
  throw new Error("ingredient_catalog_truncated");
 if(!business.data.currency||!business.data.timezone)
  throw new Error("cafe_currency_or_timezone_missing");
 return {ingredients:(ingredients.data??[]) as Ingredient[],
  quotes:(quotes.data??[]).slice(0,500) as unknown as SupplierQuote[],
  truncated:(quotes.data??[]).length>500,
  currency:business.data.currency as string,timezone:business.data.timezone as string};
}