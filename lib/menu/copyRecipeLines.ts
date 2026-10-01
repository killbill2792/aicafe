import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logQueryError } from "@/lib/data/queryError";

/** Copies every recipe line from `fromItemId` onto `toItemId` — used by "Add another size" when
 * the owner chooses to start the new size from an existing sibling's recipe. Verifies `fromItemId`
 * actually belongs to `businessId` first (never trust a client-supplied id to be the caller's own
 * item just because it's a well-formed uuid — a user may legitimately belong to more than one
 * business). Returns false on any failure (source not found/wrong business, the source-lines
 * query failing, or the insert failing) and true when the copy genuinely succeeded — including the
 * legitimate case where the source recipe is empty, which copies zero lines and is not a failure.
 * Callers must treat false as a real failure of the copy step, not as "nothing to copy." */
export async function copyRecipeLines(supabase: SupabaseClient, businessId: string, fromItemId: string, toItemId: string): Promise<boolean> {
  const { data: sourceItem, error: sourceItemError } = await supabase
    .from("menu_items")
    .select("id")
    .eq("id", fromItemId)
    .eq("business_id", businessId)
    .single();
  if (sourceItemError || !sourceItem) {
    logQueryError("copyRecipeLines:sourceItem", sourceItemError);
    return false;
  }

  const { data: sourceLines, error: linesError } = await supabase
    .from("recipe_lines")
    .select("ingredient_id, quantity, display_unit, display_quantity")
    .eq("menu_item_id", fromItemId);
  if (linesError) {
    logQueryError("copyRecipeLines:select", linesError);
    return false;
  }
  if (!sourceLines || sourceLines.length === 0) return true;

  const { error: insertError } = await supabase.from("recipe_lines").insert(
    sourceLines.map((line) => ({
      menu_item_id: toItemId,
      ingredient_id: line.ingredient_id,
      quantity: line.quantity,
      display_unit: line.display_unit,
      display_quantity: line.display_quantity,
    })),
  );
  if (insertError) {
    logQueryError("copyRecipeLines:insert", insertError);
    return false;
  }
  return true;
}
