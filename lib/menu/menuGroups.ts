import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Every distinct owner-facing menu group already in use for this business — used both to offer
 * `<datalist>` suggestions in the create/edit UI and to normalize a newly-submitted group name
 * against what already exists (see normalizeMenuGroup). */
export async function existingMenuGroups(supabase: SupabaseClient, businessId: string): Promise<string[]> {
  const { data } = await supabase.from("menu_items").select("menu_group").eq("business_id", businessId).not("menu_group", "is", null);
  return [...new Set((data ?? []).map((row) => row.menu_group as string | null).filter((group): group is string => Boolean(group && group.trim())))];
}

/** Reuses an existing group's exact spelling when the input matches case/whitespace-insensitively,
 * so owners don't end up with "Drinks" and "drinks " as two separate tabs. Only mints new literal
 * text when nothing already matches. */
export function normalizeMenuGroup(raw: string, existing: string[]): string {
  const trimmed = raw.trim();
  return existing.find((group) => group.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}
