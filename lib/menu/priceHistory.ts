import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type MenuPriceSource = "owner_manual" | "connected_pos" | "imported";

export async function setCanonicalMenuPrice(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    menuItemId: string;
    priceCents: number;
    sourceType: MenuPriceSource;
    sourceProvider?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("set_menu_item_price_with_history", {
    p_business_id: input.businessId,
    p_menu_item_id: input.menuItemId,
    p_new_price_cents: input.priceCents,
    p_source_type: input.sourceType,
    p_source_provider: input.sourceProvider ?? null,
  });
  if (error) throw error;
  return data === true;
}

export async function recordInitialMenuPrice(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    menuItemId: string;
    priceCents: number;
    sourceProvider?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("menu_price_history").insert({
    business_id: input.businessId,
    menu_item_id: input.menuItemId,
    old_price_cents: null,
    new_price_cents: input.priceCents,
    source_type: "initial",
    source_provider: input.sourceProvider ?? null,
  });
  if (error) throw error;
}
