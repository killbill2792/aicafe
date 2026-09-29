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
          priceLabel: t("priceLabel"),
          prepSecondsLabel: t("prepSecondsLabel"),
          categoryDrink: t("categoryDrink"),
          categoryFood: t("categoryFood"),
          add: t("add"),
          noItems: t("noItems"),
          recipe: t("recipe"),
          noIngredientsYet: t("noIngredientsYet"),
          ingredientLabel: t("ingredientLabel"),
          quantityLabel: t("quantityLabel"),
          newIngredient: t("newIngredient"),
          unitG: t("unitG"),
          unitMl: t("unitMl"),
          unitEach: t("unitEach"),
          addIngredient: t("addIngredient"),
          remove: t("remove"),
          deactivate: t("deactivate"),
          reactivate: t("reactivate"),
          inactiveTag: t("inactiveTag"),
        }}
      />
    </main>
  );
}
