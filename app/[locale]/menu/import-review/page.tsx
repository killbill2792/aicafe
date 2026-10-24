import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import { resolveCatalogMatch, matchUploadedItem, addUploadedItemToMenu } from "@/lib/actions/catalogMatches";
import { Link } from "@/i18n/navigation";
import BackHeader from "@/components/shared/BackHeader";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";
export default async function ImportReviewPage({searchParams}: {searchParams: Promise<{source?: string; uploadId?: string}>}) {
  await requireOwnBusiness();
  const params = await searchParams;
  const source = params.source === "upload" ? "upload" : undefined;
  const [rows, items, t, common, locale] = await Promise.all([
    getCatalogMatchReview(source ? {source,uploadId:params.uploadId} : undefined),
    getMenuItemsForEdit(),getTranslations("Menu"),getTranslations("Common"),getLocale(),
  ]);
  const backHref = source && params.uploadId ? `/more/uploads/${encodeURIComponent(params.uploadId)}` : "/menu";
  return <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
    <BackHeader title={t("matchItems")} subtitle={t("keepYourWork")} backHref={backHref} backLabel={common("back")}/>
    {rows.length === 0 ? <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted">{t("noMatches")}</p> : rows.map(row=><section key={row.id} className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <div className="flex justify-between gap-3"><div><strong className="text-lg">{row.importedName}</strong><p className="text-sm text-ink-muted">{t("syncedFrom",{source:row.provider.toUpperCase()})}</p></div>
        {row.importedPriceCents!==null && <strong>{new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(row.importedPriceCents/100)}</strong>}</div>
      {row.provider==="csv" ? <>
        <form action={matchUploadedItem.bind(null,row.id)} className="flex flex-col gap-2">
          <label htmlFor={`item-${row.id}`} className="text-sm font-semibold">{t("pickExistingItem")}</label>
          <select id={`item-${row.id}`} name="menuItemId" defaultValue={row.suggestedMenuItemId??""} required className="min-h-12 rounded-xl border border-line bg-card px-3">
            <option value="">{t("selectMenuItem")}</option>
            {items.filter(item=>item.active && (!item.posItemId || item.posItemId===row.posItemId)).map(item=><option key={item.id} value={item.id}>{item.name}{item.sizeLabel?` · ${item.sizeLabel}`:""}</option>)}
          </select>
          <button className="min-h-12 rounded-full bg-accent px-4 font-bold text-on-accent">{t("confirmMatch")}</button>
        </form>
        <form action={addUploadedItemToMenu.bind(null,row.id)}><button className="min-h-12 w-full rounded-full border border-line px-4 font-bold">{t("addToMenu")}</button></form>
        <details className="rounded-xl border border-line px-4 py-2"><summary className="min-h-10 cursor-pointer font-semibold">{t("skipForNow")}</summary><p className="text-sm text-ink-muted">{t("skipTemporary")}</p></details>
      </> : <>
        <p>{row.suggestedName ? t("possibleMatch",{name:row.suggestedName}) : t("noPossibleMatch")}</p>
        <div className="grid gap-2">
          {row.suggestedMenuItemId && <form action={resolveCatalogMatch.bind(null,row.id,"suggested")}><button className="min-h-12 w-full rounded-full bg-accent px-4 font-bold text-on-accent">{t("confirmMatch")}</button></form>}
          <form action={resolveCatalogMatch.bind(null,row.id,"new")}><button className="min-h-12 w-full rounded-full border border-line px-4 font-bold">{t("createSeparate")}</button></form>
        </div>
      </>}
    </section>)}
    {source && <Link href="/menu/import-review" className="min-h-12 self-start font-semibold text-accent-text underline">{t("allMatchItems")}</Link>}
  </PageShell>;
}
