import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import { getMenuGroupOptions } from "@/lib/actions/menuItems";
import { getIngredientUnitConversions } from "@/lib/actions/ingredientUnitConversions";
import BackHeader from "@/components/shared/BackHeader";
import ProductDetailScreen from "@/components/menu/ProductDetailScreen";
import PageShell from "@/components/shared/PageShell";
import { parseMenuDetailTab } from "@/lib/viewmodels/menuDetail";
import { stableSortSizes } from "@/lib/menu/sizeLabel";

export const dynamic = "force-dynamic";

export default async function MenuItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ setupRecipe?: string; tab?: string; edit?: string }>;
}) {
  await requireOwnBusiness();
  const [{ itemId }, { setupRecipe, tab, edit }, controlItems, { items: editItems, ingredients }, menuGroupOptions, ingredientConversions, common] = await Promise.all([
    params,
    searchParams,
    getMenuControlCenter(),
    getMenuItemsForEdit(),
    getMenuGroupOptions(),
    getIngredientUnitConversions(),
    getTranslations("Common"),
  ]);
  const item = controlItems.find((candidate) => candidate.id === itemId);
  const editItem = editItems.find((candidate) => candidate.id === itemId);
  if (!item || !editItem) notFound();
  const siblingSizes = stableSortSizes(controlItems.filter((candidate) => candidate.baseName === editItem.baseName && candidate.id !== editItem.id && candidate.active));
  const initialTab = setupRecipe === "1" ? "recipe" : parseMenuDetailTab(tab);

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6" wide>
      <BackHeader title={editItem.baseName} backHref="/menu" backLabel={common("back")} />
      <ProductDetailScreen
        item={item}
        editItem={editItem}
        ingredients={ingredients}
        menuGroupOptions={menuGroupOptions}
        ingredientConversions={ingredientConversions}
        siblingSizes={siblingSizes}
        justCreated={setupRecipe === "1"}
        initialTab={initialTab}
        initialEditing={edit === "1" && initialTab === "overview"}
      />
    </PageShell>
  );
}
