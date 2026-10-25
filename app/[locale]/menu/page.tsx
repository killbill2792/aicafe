import { Plus, Package } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import MenuCatalog from "@/components/menu/MenuCatalog";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { getLocale } from "next-intl/server";
import { getMenuCatalogPhotos } from "@/lib/data/getProductPhoto";

export const dynamic = "force-dynamic";

export default async function MenuPage() {
  await requireOwnBusiness();
  const [items, pendingMatches, t, menuBuilderT, locale] = await Promise.all([getMenuControlCenter(), getCatalogMatchReview(), getTranslations("Menu"), getTranslations("MenuBuilder"), getLocale()]);
  const photos = await getMenuCatalogPhotos(items);
  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6" wide>
      <header className="flex flex-col gap-3 px-1 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="font-headline text-[30px] font-bold text-ink">{t("title")}</h1>
          <p className="text-[15px] text-ink-muted">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/menu/pantry" aria-label={menuBuilderT("title")} className="flex min-h-12 items-center gap-2 rounded-full border border-line bg-card px-4 text-sm font-bold text-accent-text"><Package aria-hidden="true" size={19}/> {menuBuilderT("title")}</Link>
          <Link href="/menu/new" className="flex min-h-12 items-center gap-2 rounded-full bg-accent px-4 text-sm font-bold text-on-accent no-underline">
            <Plus aria-hidden="true" size={19} /> {t("addItem")}
          </Link>
        </div>
      </header>
      {pendingMatches.length > 0 && <Link href="/menu/import-review" className="mx-1 flex min-h-16 items-center justify-between rounded-card-lg border border-line bg-card px-5 py-4 no-underline">
        <span className="font-bold text-ink">{t("itemsNeedMatching",{count:new Intl.NumberFormat(locale).format(pendingMatches.length)})}</span>
        <span className="font-bold text-accent-text">{t("matchItems")}</span>
      </Link>}
      <MenuCatalog items={items} photos={photos} />
    </PageShell>
  );
}
