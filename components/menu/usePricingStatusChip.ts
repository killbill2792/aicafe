import { useTranslations } from "next-intl";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { isPricingHealthy } from "@/lib/viewmodels/menuCatalogViewModel";

/** The one simple, plain-language pricing status a café owner needs at a glance — reused by the
 * catalog list and the product detail page's overview so both say the exact same thing about the
 * exact same item. Reuses existing copy verbatim; cost/suggested-price numbers are "technical
 * details" shown separately, not part of this chip. `good` always comes from `isPricingHealthy`
 * so this can never disagree with the grouped-product status in the catalog. */
export function usePricingStatusChip() {
  const t = useTranslations("Menu");
  const tEdit = useTranslations("ManageMenu");
  return (item: Pick<MenuControlItem, "costStatus" | "pricing">): { label: string; good: boolean } => {
    const good = isPricingHealthy(item);
    if (item.costStatus !== "READY") return { label: t("recipeIncomplete"), good };
    if (!item.pricing || item.pricing.status === "PRICE_UNAVAILABLE" || item.pricing.recommendedPriceCents === null) {
      return { label: t("priceUnavailable"), good };
    }
    if (item.pricing.status === "KEEP_CURRENT_PRICE") return { label: tEdit("pricingStatusKeep"), good };
    return { label: tEdit("pricingStatusReview"), good };
  };
}
