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

export const dynamic = "force-dynamic";

export default async function MenuItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ setupRecipe?: string; tab?: string }>;
}) {
  await requireOwnBusiness();
  const [{ itemId }, { setupRecipe, tab }, controlItems, { items: editItems, ingredients }, menuGroupOptions, ingredientConversions, common] = await Promise.all([
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
  const siblingSizes = editItems.filter((candidate) => candidate.baseName === editItem.baseName && candidate.id !== editItem.id && candidate.active);
  const siblingItems = controlItems.filter((candidate) => candidate.baseName === editItem.baseName && candidate.id !== item.id && candidate.active);

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6" wide>
      <BackHeader title={item.baseName} backHref="/menu" backLabel={common("back")} />
      <ProductDetailScreen
        item={item}
        editItem={editItem}
        ingredients={ingredients}
        menuGroupOptions={menuGroupOptions}
        ingredientConversions={ingredientConversions}
        siblingSizes={siblingSizes}
        siblingItems={siblingItems}
        initialTab={tab === "recipe" || tab === "sizes" || tab === "pricing" ? tab : "overview"}
        justCreated={setupRecipe === "1"}
      />
    </PageShell>
  );
}
