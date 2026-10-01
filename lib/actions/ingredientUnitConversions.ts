"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import type { ActionResult } from "./menuItems";
import type { IngredientUnitConversion } from "@/lib/calc/recipeUnits";

async function currentBusinessId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return getActiveBusinessId(user.id);
}

/** Every operational-unit conversion for a business's ingredients, keyed by ingredient id — used
 * by the recipe editor to know which ingredients already have a "1 shot = ___" / "1 pump = ___"
 * defined, and which still need the owner to define one before that unit can be used. */
export async function getIngredientUnitConversions(): Promise<Record<string, IngredientUnitConversion[]>> {
  const businessId = await currentBusinessId();
  if (!businessId) return {};
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("ingredient_unit_conversions")
    .select("ingredient_id, unit, base_units_per_unit, ingredients!inner(business_id)")
    .eq("ingredients.business_id", businessId);
  const byIngredient: Record<string, IngredientUnitConversion[]> = {};
  for (const row of data ?? []) {
    const list = byIngredient[row.ingredient_id] ?? [];
    list.push({ unit: row.unit as "shot" | "pump", baseUnitsPerUnit: Number(row.base_units_per_unit) });
    byIngredient[row.ingredient_id] = list;
  }
  return byIngredient;
}

const SetConversionSchema = z.object({
  ingredientId: z.string().uuid(),
  unit: z.enum(["shot", "pump"]),
  baseUnitsPerUnit: z.number().positive(),
});

/** Defines (or redefines) what "1 shot"/"1 pump" means in this specific ingredient's base unit —
 * e.g. "1 shot of Espresso Beans = 18 g". Scoped to one ingredient on purpose: a dose varies by
 * ingredient and even by bottle, so this is never a global constant (see lib/calc/recipeUnits.ts). */
export async function setIngredientUnitConversion(input: z.infer<typeof SetConversionSchema>): Promise<ActionResult> {
  const parsed = SetConversionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter how much one unit is in the ingredient's own measure." };
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };
  const supabase = await createServerSupabaseClient();
  const { data: ingredient } = await supabase.from("ingredients").select("id").eq("id", parsed.data.ingredientId).eq("business_id", businessId).single();
  if (!ingredient) return { ok: false, error: "Ingredient not found." };
  const { error } = await supabase
    .from("ingredient_unit_conversions")
    .upsert({ ingredient_id: parsed.data.ingredientId, unit: parsed.data.unit, base_units_per_unit: parsed.data.baseUnitsPerUnit }, { onConflict: "ingredient_id,unit" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  return { ok: true };
}
