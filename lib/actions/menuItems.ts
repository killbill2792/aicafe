"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type ActionResultWithId = { ok: true; id: string } | { ok: false; error: string };

async function currentBusinessId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return getActiveBusinessId(user.id);
}

/** A new ingredient price must be dated by the business's own "today", not the server's UTC
 * date — snapshot queries filter prices with effective_from <= business-local today, so a price
 * stamped with a later UTC date (e.g. entered in the evening in a timezone behind UTC) would be
 * silently excluded from every cost calculation until the server's date catches up. */
async function currentBusinessTodayDateStr(businessId: string, supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>): Promise<string> {
  const { data } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  return formatInTimeZone(new Date(), data?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
}

const MenuItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  priceCents: z.number().int().positive(),
  prepSeconds: z.number().int().positive().max(3600),
  category: z.enum(["drink", "food"]),
});

/** Adds a new menu item with no recipe yet — for register plans (CSV/Excel only, no live catalog
 * sync) where nothing ever creates `menu_items` rows automatically. Without this, the Menu screen
 * and every per-drink cost number stay permanently empty for those owners. */
export async function addMenuItem(input: z.infer<typeof MenuItemSchema>): Promise<ActionResultWithId> {
  const parsed = MenuItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name, price, and prep time." };

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("menu_items")
    .insert({
      business_id: businessId,
      name: parsed.data.name,
      price_cents: parsed.data.priceCents,
      prep_seconds: parsed.data.prepSeconds,
      category: parsed.data.category,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not add the drink." };

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath("/");
  return { ok: true, id: data.id };
}

export async function setMenuItemActive(menuItemId: string, active: boolean): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("menu_items").update({ is_active: active }).eq("id", menuItemId).eq("business_id", businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  return { ok: true };
}

const RecipeLineSchema = z.object({
  menuItemId: z.string().uuid(),
  ingredientId: z.string().uuid().optional(),
  newIngredientName: z.string().trim().max(60).optional(),
  newIngredientUnit: z.enum(["g", "ml", "each"]).optional(),
  /** What a whole package of the new ingredient costs, and how much of the base unit that
   * package holds — e.g. "$50 for 2000 g of beans". Both optional: an owner can add the
   * recipe now and price it later once they know the cost. */
  newIngredientCostCents: z.number().int().positive().optional(),
  newIngredientCostQuantity: z.number().positive().optional(),
  quantity: z.number().positive(),
});

/** Adds one recipe line (an ingredient + how much of it a drink uses). Either an existing
 * `ingredientId` or a `newIngredientName`+`newIngredientUnit` to create one first — matches the
 * same "confirm the unit for anything new" pattern as the ingredient-cost importer. */
export async function addRecipeLine(input: z.infer<typeof RecipeLineSchema>): Promise<ActionResult> {
  const parsed = RecipeLineSchema.safeParse(input);
  if (!parsed.success || (!parsed.data.ingredientId && !parsed.data.newIngredientName)) {
    return { ok: false, error: "Pick an ingredient and a quantity." };
  }

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();

  let ingredientId = parsed.data.ingredientId;
  if (!ingredientId) {
    // Match by name (case-insensitive) before creating — typing a name that already exists
    // should reuse it, not silently fork a second "Milk" with no way to tell them apart.
    const { data: existing } = await supabase
      .from("ingredients")
      .select("id, name")
      .eq("business_id", businessId)
      .ilike("name", parsed.data.newIngredientName!);
    ingredientId = existing?.find((i) => i.name.toLowerCase() === parsed.data.newIngredientName!.toLowerCase())?.id;

    if (!ingredientId) {
      const { data: created, error: createError } = await supabase
        .from("ingredients")
        .insert({ business_id: businessId, name: parsed.data.newIngredientName, base_unit: parsed.data.newIngredientUnit ?? "g" })
        .select("id")
        .single();
      if (createError || !created) return { ok: false, error: createError?.message ?? "Could not add the ingredient." };
      ingredientId = created.id;
    }

    // A cost may be entered whether this reused a name match or just created the ingredient —
    // either way it's a new price point, so it's always worth recording.
    if (parsed.data.newIngredientCostCents && parsed.data.newIngredientCostQuantity) {
      // Same ×1,000,000 cents-to-micros convention as csvImport.ts — see the note there.
      const costPerBaseUnitMicros = Math.round((parsed.data.newIngredientCostCents / parsed.data.newIngredientCostQuantity) * 1_000_000);
      const { error: priceError } = await supabase.from("ingredient_prices").insert({
        ingredient_id: ingredientId,
        effective_from: await currentBusinessTodayDateStr(businessId, supabase),
        cost_per_base_unit_micros: costPerBaseUnitMicros,
        source: "manual",
      });
      if (priceError) return { ok: false, error: priceError.message };
    }
  }

  const { error } = await supabase
    .from("recipe_lines")
    .upsert({ menu_item_id: parsed.data.menuItemId, ingredient_id: ingredientId, quantity: parsed.data.quantity }, { onConflict: "menu_item_id,ingredient_id" });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath("/");
  return { ok: true };
}

export async function deleteRecipeLine(menuItemId: string, ingredientId: string): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("recipe_lines").delete().eq("menu_item_id", menuItemId).eq("ingredient_id", ingredientId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  return { ok: true };
}
