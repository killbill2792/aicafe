import { CreditCard, FileSpreadsheet, Package, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getUploadHistory, type UploadHistoryRow } from "@/lib/data/getUploadHistory";
import BackHeader from "@/components/shared/BackHeader";
import type { SalesImportSummary } from "@/lib/actions/csvImport";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

const KIND_ICON = { sales_csv: FileSpreadsheet, labor_csv: Users, ingredients_csv: Package, processing_fees_csv: CreditCard } as const;

export default async function UploadHistoryPage() {
  await requireOwnBusiness();
  const uploads = await getUploadHistory();
  const t = await getTranslations("UploadHistory");
  const tCommon = await getTranslations("Common");

  const kindLabel = (kind: UploadHistoryRow["kind"]) => (kind === "sales_csv" ? t("kindSales") : kind === "labor_csv" ? t("kindLabor") : kind === "processing_fees_csv" ? t("kindProcessingFees") : t("kindIngredients"));

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />

      {uploads.length === 0 ? (
        <p className="rounded-card-lg bg-card p-5 text-center text-base text-ink-muted">{t("emptyState")}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {uploads.map((upload) => {
            const Icon = KIND_ICON[upload.kind];
            const summary = upload.summary;
            const unmatchedNames = summary && "unmatchedItems" in summary ? (summary as SalesImportSummary).unmatchedItems.map((u) => u.name) : [];
            const dateFrom = summary && "dateFrom" in summary ? summary.dateFrom : null;
            const dateTo = summary && "dateTo" in summary ? summary.dateTo : null;
            return (
              <div key={upload.id} className="flex flex-col gap-1.5 rounded-[20px] bg-card p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-paper text-ink-muted">
                    <Icon aria-hidden="true" size={20} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-base font-bold">{kindLabel(upload.kind)}</span>
                    <span className="text-xs text-ink-muted">{new Date(upload.createdAt).toLocaleString()}</span>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${upload.status === "needs_review" ? "bg-warn-tint text-warn" : "bg-good-tint text-good"}`}>
                    {upload.status === "needs_review" ? t("statusNeedsReview") : t("statusDone")}
                  </span>
                </div>
                {summary && (
                  <div className="flex flex-col gap-0.5 pl-14 text-sm text-ink-muted">
                    <span>{t("rowsLine", { imported: "imported" in summary ? summary.imported : summary.importedDates, rowsInFile: summary.rowsInFile })}</span>
                    {dateFrom && dateTo && <span>{t("dateRangeLine", { dateFrom, dateTo })}</span>}
                    {unmatchedNames.length > 0 && <span className="font-semibold text-warn">{t("unmatchedInline", { names: unmatchedNames.join(", ") })}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
