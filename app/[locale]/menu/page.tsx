import { Settings2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import MenuCatalog from "@/components/menu/MenuCatalog";
import { Link } from "@/i18n/navigation";

export const dynamic = "force-dynamic";

export default async function MenuPage() {
  await requireOwnBusiness();
  const [items, t] = await Promise.all([getMenuControlCenter(), getTranslations("Menu")]);
  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <h1 className="font-headline text-[30px] font-bold text-ink">{t("title")}</h1>
        <div className="flex items-center gap-2">
          <Link href="/menu/manage" className="flex min-h-12 items-center gap-2 rounded-full bg-card px-3 text-sm font-bold text-ink no-underline">
            <Settings2 aria-hidden="true" size={19} /> {t("manageMenu")}
          </Link>
          <LanguageSwitch href="/menu" />
        </div>
      </header>
      <Link href="/menu/import-review" className="mx-1 text-sm font-bold text-good underline">{t("reviewMatches")}</Link>
      <MenuCatalog items={items} labels={{
        search: t("search"), all: t("all"), coffee: t("coffee"), tea: t("tea"), food: t("food"), needsAttention: t("needsAttention"),
        cost: t("cost"), afterIngredients: t("afterIngredients"), suggested: t("suggested"), keepPrice: t("keepPrice"), noRecipe: t("noRecipe"),
        missingCost: t("missingCost"), syncedFrom: t("syncedFrom"), inactive: t("inactive"), empty: t("empty"), addItem: t("addItem"),
      }} />
    </main>
  );
}
