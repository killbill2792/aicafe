import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import MenuCatalog from "@/components/menu/MenuCatalog";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { getMenuCatalogPhotos } from "@/lib/data/getProductPhoto";

export const dynamic = "force-dynamic";

export default async function MenuPage() {
  await requireOwnBusiness();
  const [items, pendingMatches, t] = await Promise.all([getMenuControlCenter(), getCatalogMatchReview(), getTranslations("Menu")]);
  const photos = await getMenuCatalogPhotos(items);
  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6" wide>
      <header className="flex flex-col gap-3 px-1 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="font-headline text-[30px] font-bold text-ink">{t("title")}</h1>
          <p className="text-[15px] text-ink-muted">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/menu/new" className="flex min-h-12 items-center gap-2 rounded-full bg-ink px-4 text-sm font-bold text-paper no-underline">
            <Plus aria-hidden="true" size={19} /> {t("addItem")}
          </Link>
          <LanguageSwitch href="/menu" />
        </div>
      </header>
      {pendingMatches.length > 0 && <Link href="/menu/import-review" className="mx-1 text-sm font-bold text-good underline">{t("reviewMatches")}</Link>}
      <MenuCatalog items={items} photos={photos} />
    </PageShell>
  );
}
