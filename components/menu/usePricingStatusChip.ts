import { useTranslations } from "next-intl";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { getItemPricingStatus } from "@/lib/viewmodels/menuCatalogViewModel";

/** The one simple, plain-language pricing status a café owner needs at a glance — reused by the
 * catalog list and the product detail page's overview so both say the exact same thing about the
 * exact same item. "Price may be low/high" (rather than a generic "worth reviewing") tells the
 * owner which direction to look without them needing to compare the two numbers themselves.
 * `good`/`label` are both derived from `getItemPricingStatus`, the same classification the
 * grouped-product status in the catalog uses, so they can never disagree. */
export function usePricingStatusChip() {
  const t = useTranslations("Menu");
  const tEdit = useTranslations("ManageMenu");
  return (item: Pick<MenuControlItem, "costStatus" | "pricing">): { label: string; good: boolean } => {
    const status = getItemPricingStatus(item);
    switch (status.kind) {
      case "incomplete_recipe":
        return { label: t("recipeIncomplete"), good: false };
      case "price_unavailable":
        return { label: t("priceUnavailable"), good: false };
      case "keep":
        return { label: tEdit("pricingStatusKeep"), good: true };
      case "low":
        return { label: t("priceMayBeLow"), good: false };
      case "high":
        return { label: t("priceMayBeHigh"), good: false };
    }
  };
}
