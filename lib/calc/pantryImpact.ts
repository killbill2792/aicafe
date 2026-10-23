import { evaluateRecipeCost, resolveProductCost } from "./ingredients";

export type PantryImpactItem = { id: string; name: string; priceCents: number | null };
export type PantryImpactRecipeLine = { menuItemId: string; ingredientId: string; quantity: number };
export type PantryFallback = { costCents: number; status: "confirmed" | "estimated" };
export type PantryImpactCostBasis = "recipe" | "owner_total_confirmed" | "owner_total_estimated" | null;
export type PantryImpactRow = { menuItemId: string; name: string; priceCents: number | null;
  beforeCostCents: number | null; afterCostCents: number | null;
  marginBeforeCents: number | null; marginAfterCents: number | null;
  marginChangeCents: number | null;
  beforeCostBasis: PantryImpactCostBasis; afterCostBasis: PantryImpactCostBasis };

/** Every cost and margin computation belongs in this pure layer. Never turn unknown
 * ingredient cost or an unpriced menu size into a zero-dollar expense or margin. */
export function calculatePantryPriceImpact(
  items: readonly PantryImpactItem[],
  lines: readonly PantryImpactRecipeLine[],
  currentPrices: Readonly<Record<string, number>>,
  changedIngredientId: string,
  newMicroCents: number,
  ownerFallbacks: Readonly<Record<string, PantryFallback>> = {},
): PantryImpactRow[] {
  const proposedPrices = { ...currentPrices, [changedIngredientId]: newMicroCents };
  return items.map((item) => {
    const recipe = lines.filter((line) => line.menuItemId === item.id)
      .map((line) => ({ ingredientId: line.ingredientId, quantity: line.quantity }));
    const fallback = ownerFallbacks[item.id];
    const ownerTotal = fallback?.costCents ?? null;
    const before = resolveProductCost(evaluateRecipeCost(recipe, currentPrices), ownerTotal);
    const after = resolveProductCost(evaluateRecipeCost(recipe, proposedPrices), ownerTotal);
    const beforeCostCents = before.costCents === null ? null : Math.round(before.costCents);
    const afterCostCents = after.costCents === null ? null : Math.round(after.costCents);
    const priceCents = item.priceCents;
    const marginBeforeCents = priceCents === null || beforeCostCents === null
      ? null : priceCents - beforeCostCents;
    const marginAfterCents = priceCents === null || afterCostCents === null
      ? null : priceCents - afterCostCents;
    const basis = (source: "recipe" | "owner_total" | "combo" | null): PantryImpactCostBasis =>
      source === "recipe" ? "recipe" : source === "owner_total"
        ? fallback?.status === "estimated" ? "owner_total_estimated" : "owner_total_confirmed"
        : null;
    return { menuItemId: item.id, name: item.name, priceCents,
      beforeCostBasis: basis(before.source), afterCostBasis: basis(after.source),
      beforeCostCents, afterCostCents, marginBeforeCents, marginAfterCents,
      marginChangeCents: marginBeforeCents === null || marginAfterCents === null
        ? null : marginAfterCents - marginBeforeCents };
  });
}
