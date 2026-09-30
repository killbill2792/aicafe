import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import BackHeader from "@/components/shared/BackHeader";
import ManageMenuPanel from "@/components/menu/ManageMenuPanel";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ManageMenuPage() {
  await requireOwnBusiness();
  const t = await getTranslations("ManageMenu");
  const tCommon = await getTranslations("Common");

  const { items, ingredients } = await getMenuItemsForEdit();

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/menu" backLabel={tCommon("back")} />
      <ManageMenuPanel
        items={items}
        ingredients={ingredients}
        labels={{
          addDrink: t("addDrink"),
          nameLabel: t("nameLabel"),
          sizeLabel: t("sizeLabel"),
          sizeHint: t("sizeHint"),
          addAnotherSize: t("addAnotherSize"),
          priceLabel: t("priceLabel"),
          prepSecondsLabel: t("prepSecondsLabel"),
          prepSecondsHelp: t("prepSecondsHelp"),
          categoryDrink: t("categoryDrink"),
          categoryFood: t("categoryFood"),
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
        }}
      />
    </main>
  );
}
