import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

/** Lower-cased ingredient names already on file, so the ingredient-cost importer can tell a
 * price update for an existing ingredient apart from a brand-new one (which needs a base unit
 * chosen before it can be created). */
export async function getIngredientNames(): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase.from("ingredients").select("name").eq("business_id", businessId);
  return (data ?? []).map((r) => r.name.toLowerCase());
}
