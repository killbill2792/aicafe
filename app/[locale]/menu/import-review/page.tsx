import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import { resolveCatalogMatch } from "@/lib/actions/catalogMatches";
import { formatCents } from "@/lib/calc";
import BackHeader from "@/components/shared/BackHeader";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";
export default async function ImportReviewPage() {
  await requireOwnBusiness(); const [rows, t, common] = await Promise.all([getCatalogMatchReview(), getTranslations("Menu"), getTranslations("Common")]);
  return <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6"><BackHeader title={t("reviewMatches")} subtitle={t("keepYourWork")} backHref="/menu" backLabel={common("back")} />
    {rows.length === 0 ? <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted">{t("noMatches")}</p> : rows.map((row) => <section key={row.id} className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]"><div className="flex justify-between gap-3"><div><strong className="text-lg">{row.importedName}</strong><p className="text-sm text-ink-muted">{t("syncedFrom", { source: row.provider.toUpperCase() })}</p></div>{row.importedPriceCents !== null && <strong>{formatCents(row.importedPriceCents)}</strong>}</div><p>{row.suggestedName ? t("possibleMatch", { name: row.suggestedName }) : t("noPossibleMatch")}</p><div className="grid gap-2">{row.suggestedMenuItemId && <form action={resolveCatalogMatch.bind(null, row.id, "suggested")}><button className="min-h-12 w-full rounded-full bg-ink px-4 font-bold text-paper">{t("confirmMatch")}</button></form>}<form action={resolveCatalogMatch.bind(null, row.id, "new")}><button className="min-h-12 w-full rounded-full border border-line px-4 font-bold">{t("createSeparate")}</button></form></div></section>)}
  </PageShell>;
}
