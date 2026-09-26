import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { itemIngredientCostCents } from "@/lib/calc";

/**
 * Recomputes daily_rollups for one business_date from the raw orders/order_lines/timecards
 * already in the DB (docs/06-integrations.md: "After each sync, recompute daily_rollups for
 * affected business dates, then alerts"). Ingredients are theoretical, priced as of `businessDate`.
 */
export async function recomputeDailyRollup(supabase: SupabaseClient, businessId: string, businessDate: string): Promise<void> {
  const { data: business } = await supabase.from("businesses").select("payroll_tax_rate").eq("id", businessId).single();
  const payrollTaxRate = Number(business?.payroll_tax_rate ?? 0.12);

  const { data: orders } = await supabase
    .from("orders")
    .select("id, net_sales_cents, processing_fee_cents")
    .eq("business_id", businessId)
    .eq("business_date", businessDate);

  const orderIds = (orders ?? []).map((o) => o.id);
  const netSalesCents = (orders ?? []).reduce((s, o) => s + o.net_sales_cents, 0);
  const cardFeesCents = (orders ?? []).reduce((s, o) => s + o.processing_fee_cents, 0);
  const ordersCount = orderIds.length;

  const { data: lines } = orderIds.length
    ? await supabase
        .from("order_lines")
        .select("id, order_id, menu_item_id, quantity, net_sales_cents, voided")
        .in("order_id", orderIds)
    : { data: [] };

  const nonVoidedLines = (lines ?? []).filter((l) => !l.voided);
  const voidedLines = (lines ?? []).filter((l) => l.voided);
  const drinksCount = nonVoidedLines.reduce((s, l) => s + Number(l.quantity), 0);
  const voidsCents = voidedLines.reduce((s, l) => s + l.net_sales_cents, 0);

  // Theoretical ingredient cost: recipe cost per menu item × quantity sold, at this date's prices.
  const menuItemIds = [...new Set(nonVoidedLines.map((l) => l.menu_item_id).filter(Boolean))];
  let ingredientsCents = 0;
  if (menuItemIds.length > 0) {
    const { data: recipeLines } = await supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", menuItemIds);
    const ingredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
    const { data: priceRows } = ingredientIds.length
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros")
          .in("ingredient_id", ingredientIds)
          .lte("effective_from", businessDate)
          .order("effective_from", { ascending: true })
      : { data: [] };
    const priceMicros: Record<string, number> = {};
    for (const row of priceRows ?? []) priceMicros[row.ingredient_id] = row.cost_per_base_unit_micros;

    const recipeByItem = new Map<string, { ingredientId: string; quantity: number }[]>();
    for (const r of recipeLines ?? []) {
      const arr = recipeByItem.get(r.menu_item_id) ?? [];
      arr.push({ ingredientId: r.ingredient_id, quantity: Number(r.quantity) });
      recipeByItem.set(r.menu_item_id, arr);
    }

    for (const line of nonVoidedLines) {
      const recipe = line.menu_item_id ? recipeByItem.get(line.menu_item_id) : undefined;
      if (recipe) ingredientsCents += itemIngredientCostCents(recipe, priceMicros) * Number(line.quantity);
    }
  }

  const { data: timecards } = await supabase
    .from("timecards")
    .select("clock_in, clock_out, hourly_wage_cents, breaks")
    .eq("business_id", businessId)
    .gte("clock_in", `${businessDate}T00:00:00Z`)
    .lt("clock_in", `${businessDate}T23:59:59.999Z`);

  const wagesCents = (timecards ?? []).reduce((sum, tc) => {
    const clockOut = tc.clock_out ? new Date(tc.clock_out).getTime() : Date.now();
    const totalMs = Math.max(0, clockOut - new Date(tc.clock_in).getTime());
    const unpaidBreakMs = (tc.breaks ?? [])
      .filter((b: { paid: boolean }) => !b.paid)
      .reduce((s: number, b: { start: string; end: string }) => s + Math.max(0, new Date(b.end).getTime() - new Date(b.start).getTime()), 0);
    const paidHours = Math.max(0, totalMs - unpaidBreakMs) / 3_600_000;
    return sum + paidHours * tc.hourly_wage_cents;
  }, 0);
  const staffTaxCents = Math.round(wagesCents * payrollTaxRate);

  await supabase.from("daily_rollups").upsert(
    {
      business_id: businessId,
      business_date: businessDate,
      net_sales_cents: netSalesCents,
      orders_count: ordersCount,
      drinks_count: drinksCount,
      ingredients_cents: Math.round(ingredientsCents),
      staff_wages_cents: Math.round(wagesCents),
      staff_tax_cents: staffTaxCents,
      card_fees_cents: cardFeesCents,
      voids_cents: voidsCents,
    },
    { onConflict: "business_id,business_date" },
  );
}
