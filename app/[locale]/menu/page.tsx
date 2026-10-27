import { Plus, Package } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { getUnpricedPublishedMenu } from "@/lib/data/getUnpricedPublishedMenu";
import {formatCents} from "@/lib/utils/money";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import MenuCatalog from "@/components/menu/MenuCatalog";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { getLocale } from "next-intl/server";
import { getMenuCatalogPhotos } from "@/lib/data/getProductPhoto";

export const dynamic = "force-dynamic";

export default async function MenuPage() {
  await requireOwnBusiness();
  const [items, pendingMatches, t, menuBuilderT, locale, unpriced] = await Promise.all([getMenuControlCenter(), getCatalogMatchReview(), getTranslations("Menu"), getTranslations("MenuBuilder"), getLocale(), getUnpricedPublishedMenu()]);
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
      {unpriced.length>0&&<section aria-label={t("unpricedPublished")} className="mt-3">
        <h2 className="mb-3 font-headline text-xl font-bold text-ink">{t("unpricedPublished")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {unpriced.map(item=><article key={item.id} className="rounded-card-lg border border-line bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-bold text-ink">{item.name}{item.sizeLabel?` · ${item.sizeLabel}`:""}</h3>
                {item.menuGroup&&<p className="text-sm text-ink-muted">{item.menuGroup}</p>}
                {item.description&&<p className="mt-2 text-sm text-ink-muted">{item.description}</p>}
                {item.category&&<p className="mt-1 text-sm text-ink-muted">{item.category}</p>}
                {item.visibility&&<p className="mt-1 text-xs text-ink-muted">{t("visibility")}: {item.visibility}</p>}
              </div>
              <span className="shrink-0 rounded-lg bg-paper px-3 py-2 text-sm font-bold text-ink">
                {item.pricingStrategy==="OPEN_PRICE"?t("openPrice"):menuBuilderT("priceNotSet")}
              </span>
            </div>
            {item.addons.length>0&&<div className="mt-3 border-t border-line pt-2">
              <p className="mb-1 text-sm font-bold text-ink">{t("addOnPrices")}</p>
              <ul className="space-y-1">{item.addons.map((addon,index)=><li key={index} className="flex justify-between gap-3 text-sm text-ink-muted">
                <span>{addon.groupName?addon.groupName+" · ":""}{addon.name}</span>
                <span>{addon.priceCents===null?menuBuilderT("priceNotSet"):formatCents(addon.priceCents)}</span>
              </li>)}</ul>
            </div>}
          </article>)}
        </div>
      </section>
    </PageShell>
  );
}
