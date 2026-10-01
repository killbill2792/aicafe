import { notFound } from "next/navigation";
import { Archive, ChefHat, Pencil, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { formatCents } from "@/lib/calc";
import { Link } from "@/i18n/navigation";
import BackHeader from "@/components/shared/BackHeader";

export const dynamic = "force-dynamic";

export default async function MenuItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  await requireOwnBusiness();
  const [{ itemId }, items, t, common] = await Promise.all([params, getMenuControlCenter(), getTranslations("Menu"), getTranslations("Common")]);
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) notFound();
  const editHref = `/menu/manage?item=${item.id}` as const;
  return <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
    <BackHeader title={item.name} subtitle={item.sizeLabel ?? undefined} backHref="/menu" backLabel={common("back")} />
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <div className="flex items-end justify-between gap-3"><span className="text-[17px] text-ink-muted">{t("sellingPrice")}</span><strong className="font-headline text-4xl">{formatCents(item.priceCents)}</strong></div>
      {item.catalogSource !== "manual" && <p className="text-sm text-ink-muted">{t("syncedFrom", { source: item.provenance.replace("_", " ") })}</p>}
      <span className={`w-fit rounded-full px-3 py-1 text-sm font-bold ${item.active ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>{item.active ? t("active") : t("inactive")}</span>
    </section>
    {item.costStatus === "READY" && item.ingredientsCostCents !== null ? <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <h2 className="text-lg font-bold">{t("economics")}</h2>
      <Row label={t("sellingPrice")} value={formatCents(item.priceCents)} />
      <Row label={t("ingredients")} value={formatCents(item.ingredientsCostCents)} />
      <div className="flex h-3 overflow-hidden rounded-full bg-good-tint"><span className="bg-ingredients" style={{ width: `${Math.min(100, item.ingredientsCostCents / item.priceCents * 100)}%` }} /></div>
      <Row label={t("afterIngredients")} value={formatCents(item.priceCents - item.ingredientsCostCents)} strong />
      {item.pricing && <Row label={t("suggestedPrice")} value={
        item.pricing.status === "KEEP_CURRENT_PRICE" ? t("keepPrice")
        : item.pricing.status === "PRICE_UNAVAILABLE" || item.pricing.recommendedPriceCents === null ? t("priceUnavailable")
        : formatCents(item.pricing.recommendedPriceCents)
      } strong />}
    </section> : <section className="rounded-card-lg bg-warn-tint p-[18px] text-warn"><h2 className="text-lg font-bold">{t("needsAttention")}</h2><p className="mt-1 text-[17px]">{item.costStatus === "NO_RECIPE" ? t("noRecipe") : t("missingCost", { ingredient: item.missingCostIngredientNames.join(", ") })}</p></section>}
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <h2 className="text-lg font-bold">{t("recipe")}</h2>
      {item.recipe.length ? item.recipe.map((line) => <div key={line.ingredientId} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0"><div><strong>{line.ingredientName}</strong><p className="text-sm text-ink-muted">{line.quantity} {line.baseUnit}</p></div><span className={line.costCents === null ? "font-bold text-warn" : "font-bold"}>{line.costCents === null ? t("costMissing") : formatCents(line.costCents)}</span></div>) : <p className="text-ink-muted">{t("noRecipe")}</p>}
    </section>
    {(item.unitsSold !== null || item.revenueCents !== null) && <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]"><h2 className="text-lg font-bold">{t("recentSales")}</h2>{item.unitsSold !== null && <Row label={t("unitsSold")} value={String(item.unitsSold)} />}{item.revenueCents !== null && <Row label={t("revenue")} value={formatCents(item.revenueCents)} />}</section>}
    <div className="grid gap-2">
      <Action href={editHref} icon={<Pencil aria-hidden="true" size={19} />} label={t("editProduct")} />
      <Action href={editHref} icon={<ChefHat aria-hidden="true" size={19} />} label={t("editRecipe")} />
      {item.costStatus === "MISSING_INGREDIENT_COST" && <Action href={editHref} icon={<Plus aria-hidden="true" size={19} />} label={t("addMissingCost")} />}
      <Action href={editHref} icon={<Archive aria-hidden="true" size={19} />} label={item.active ? t("archiveItem") : t("restoreItem")} />
    </div>
  </main>;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) { return <div className="flex items-center justify-between gap-3 text-[17px]"><span className="text-ink-muted">{label}</span><span className={strong ? "font-bold text-good" : "font-semibold"}>{value}</span></div>; }
function Action({ href, icon, label }: { href: `/menu/manage?item=${string}`; icon: React.ReactNode; label: string }) { return <Link href={href} className="flex min-h-12 items-center gap-2 rounded-full border border-line bg-card px-4 font-bold text-ink no-underline">{icon}{label}</Link>; }
