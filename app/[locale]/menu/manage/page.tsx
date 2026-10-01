import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import BackHeader from "@/components/shared/BackHeader";
import ManageMenuPanel from "@/components/menu/ManageMenuPanel";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getPricingInputs } from "@/lib/data/getPricingInputs";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ManageMenuPage({ searchParams }: { searchParams: Promise<{ add?: string; item?: string }> }) {
  const user = await requireOwnBusiness();
  const t = await getTranslations("ManageMenu");
  const tCommon = await getTranslations("Common");

  const { items, ingredients } = await getMenuItemsForEdit();
  const query = await searchParams;
  const pricing = user && isSupabaseConfigured()
    ? Object.fromEntries(buildPricingViewModel(await getPricingInputs(await createServerSupabaseClient(), await getActiveBusinessId(user.id))).map((row) => [row.itemId, row.result]))
    : {};

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/menu" backLabel={tCommon("back")} />
      <ManageMenuPanel
        items={items}
        ingredients={ingredients}
        pricing={pricing}
        showCreate={query.add === "1" || items.length === 0}
        initialItemId={query.item}
        labels={{
          addDrink: t("addDrink"),
          nameLabel: t("nameLabel"),
          sizeLabel: t("sizeLabel"),
          sizeHint: t("sizeHint"),
          addAnotherSize: t("addAnotherSize"),
          priceLabel: t("priceLabel"),
          prepSecondsLabel: t("prepSecondsLabel"),
          prepSecondsHelp: t("prepSecondsHelp"),
          categoryLabel: t("categoryLabel"),
          categories: {
            ESPRESSO_DRINK: t("categoryEspressoDrink"), BREWED_COFFEE: t("categoryBrewedCoffee"), COLD_BREW: t("categoryColdBrew"), TEA: t("categoryTea"),
            SPECIALTY_DRINK: t("categorySpecialtyDrink"), PASTRY: t("categoryPastry"), FOOD: t("categoryFood"), RETAIL: t("categoryRetail"),
          },
          add: t("add"),
          noItems: t("noItems"),
          recipe: t("recipe"),
          recipeHint: t("recipeHint"),
          ingredientAdded: t("ingredientAdded"),
          noIngredientsYet: t("noIngredientsYet"),
          ingredientColumnLabel: t("ingredientColumnLabel"),
          amountColumnLabel: t("amountColumnLabel"),
          ingredientLabel: t("ingredientLabel"),
          quantityLabel: t("quantityLabel"),
          newIngredient: t("newIngredient"),
          ingredientCostLabel: t("ingredientCostLabel"),
          ingredientCostForLabel: t("ingredientCostForLabel"),
          ingredientCostHint: t("ingredientCostHint"),
          unitG: t("unitG"),
          unitMl: t("unitMl"),
          unitEach: t("unitEach"),
          addIngredient: t("addIngredient"),
          remove: t("remove"),
          deactivate: t("deactivate"),
          reactivate: t("reactivate"),
          inactiveTag: t("inactiveTag"),
          suggestedPriceLabel: t("suggestedPriceLabel"),
          suggestedPriceHint: t("suggestedPriceHint"),
          pricingStatus: { NEW_PRICE: t("pricingStatusNew"), KEEP_CURRENT_PRICE: t("pricingStatusKeep"), REVIEW_PRICE: t("pricingStatusReview") },
          pricingExplainer: { BENCHMARK_EXPLAINER: t("pricingExplainerBenchmark"), BUSINESS_ADJUSTED_EXPLAINER: t("pricingExplainerBusinessAdjusted"), INCOMPLETE_DATA_EXPLAINER: t("pricingExplainerIncomplete") },
          pricingWarnings: { BUSINESS_ADJUSTMENT_CAPPED: t("pricingWarningCapped"), CATEGORY_PRICE_OUTLIER: t("pricingWarningCategoryOutlier"), CATEGORY_COST_PERCENT_OUTLIER: t("pricingWarningCostOutlier"), INCOMPLETE_RECIPE: t("pricingWarningIncompleteRecipe"), LOW_SAMPLE_SIZE: t("pricingWarningLowSample") },
        }}
      />
    </main>
  );
}
