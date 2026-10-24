import { ChevronRight, CreditCard, FileSpreadsheet, Package, Receipt, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getUploadHistory, type UploadHistoryRow } from "@/lib/data/getUploadHistory";
import BackHeader from "@/components/shared/BackHeader";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

const KIND_ICON = { sales_csv: FileSpreadsheet, labor_csv: Users, ingredients_csv: Package, processing_fees_csv: CreditCard };

export default async function UploadsPage() {
  await requireOwnBusiness();
  const [t, h, common, locale, uploads] = await Promise.all([
    getTranslations("Uploads"), getTranslations("UploadHistory"), getTranslations("Common"), getLocale(), getUploadHistory(),
  ]);
  const last = (kind: UploadHistoryRow["kind"]) => uploads.find((row) => row.kind === kind);
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
  const links = [
    { href: "/more/uploads/sales", kind: "sales_csv" as const, Icon: FileSpreadsheet, label: t("salesLink"), hint: t("salesLinkHint") },
    { href: "/more/uploads/processing-fees", kind: "processing_fees_csv" as const, Icon: CreditCard, label: t("processingFeesLink"), hint: t("processingFeesLinkHint") },
    { href: "/more/uploads/labor", kind: "labor_csv" as const, Icon: Users, label: t("laborLink"), hint: t("laborLinkHint") },
    { href: "/more/uploads/ingredients", kind: "ingredients_csv" as const, Icon: Package, label: t("ingredientsLink"), hint: t("ingredientsLinkHint") },
    { href: "/add-cost/statement", kind: null, Icon: Receipt, label: t("bankLink"), hint: t("bankLinkHint") },
  ];
  const kindName = (kind: UploadHistoryRow["kind"]) => kind === "sales_csv" ? h("kindSales") : kind === "labor_csv" ? h("kindLabor") : kind === "ingredients_csv" ? h("kindIngredients") : h("kindProcessingFees");
  const statusName = (status: UploadHistoryRow["status"]) => h(status === "done" ? "statusDone" : status === "failed" ? "statusFailed" : status === "processing" ? "statusProcessing" : "statusNeedsReview");
  return <PageShell className="flex flex-col gap-5 px-4 py-6">
    <BackHeader title={t("title")} backHref="/more" backLabel={common("back")} />
    <p className="text-[15px] text-ink-muted">{t("intro")}</p>
    <div className="flex flex-col rounded-card-lg bg-card px-2">
      {links.map(({href,kind,Icon,label,hint}) => <Link key={href} href={href} className="flex items-center gap-3 border-b border-line px-2.5 py-4 text-ink no-underline last:border-b-0">
        <Icon aria-hidden="true" size={20} className="shrink-0 text-ink-muted"/>
        <span className="flex min-w-0 flex-1 flex-col"><span className="text-base font-semibold">{label}</span><span className="text-sm text-ink-muted">{hint}</span>
          {kind && last(kind) && <span className="mt-1 text-xs text-ink-muted">{t("lastUpload", {date: formatDate(last(kind)!.createdAt)})}</span>}
        </span><ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-muted rtl:rotate-180"/>
      </Link>)}
    </div>
    <section id="upload-history" className="flex flex-col gap-3 scroll-mt-6">
      <h2 className="font-headline text-xl font-bold">{h("title")}</h2>
      <p className="text-sm text-ink-muted">{h("subtitle")}</p>
      {uploads.length === 0 ? <p className="rounded-card-lg bg-card p-5 text-ink-muted">{h("emptyState")}</p> : <div className="flex flex-col gap-2">
        {uploads.map(upload => {
          const Icon = KIND_ICON[upload.kind];
          return <Link key={upload.id} href={`/more/uploads/${upload.id}`} className="flex min-h-16 items-center gap-3 rounded-card-lg bg-card p-4 text-ink no-underline">
            <Icon aria-hidden="true" size={20} className="shrink-0 text-ink-muted"/>
            <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{kindName(upload.kind)}</span>
              <span className="text-xs text-ink-muted">{formatDate(upload.createdAt)}</span>
              {upload.summary && <span className="text-sm text-ink-muted">{upload.kind === "sales_csv"
                ? h("salesGroupsLine", {groups:new Intl.NumberFormat(locale).format("imported" in upload.summary ? upload.summary.imported : 0), rowsInFile:new Intl.NumberFormat(locale).format(upload.summary.rowsInFile)})
                : upload.kind === "processing_fees_csv"
                  ? h("feeDatesLine", {dates:new Intl.NumberFormat(locale).format("importedDates" in upload.summary ? upload.summary.importedDates : 0), rowsInFile:new Intl.NumberFormat(locale).format(upload.summary.rowsInFile)})
                  : h("rowsLine", {imported:new Intl.NumberFormat(locale).format("imported" in upload.summary ? upload.summary.imported : 0), rowsInFile:new Intl.NumberFormat(locale).format(upload.summary.rowsInFile)})}</span>}
            </span><span className="text-xs font-semibold text-warn">{statusName(upload.status)}</span>
            <ChevronRight aria-hidden="true" size={18} className="shrink-0 rtl:rotate-180"/>
          </Link>;
        })}
      </div>}
    </section>
  </PageShell>;
}
