import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";

/** Owner-session, business-scoped price read. Never fall back to service-role
 * access: inactive/missing items are not eligible for proposals. */
export async function ownerMenuPrice(
  scope:{businessId:string},productId:string,
  client?:Awaited<ReturnType<typeof createServerSupabaseClient>>
):Promise<number|null>{
  const supabase=client??await createServerSupabaseClient();
  const {data,error}=await supabase.from("menu_items").select("price_cents,is_active")
    .eq("business_id",scope.businessId).eq("id",productId).maybeSingle();
  if(error)throw new Error("Menu price unavailable");
  if(!data||!data.is_active)return null;
  return Number(data.price_cents);
}
