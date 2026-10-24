import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getUploadReview } from "@/lib/data/getUploadHistory";
import { resolveLaborImportWage, type SalesImportSummary, type LaborImportSummary, type IngredientImportSummary, type ProcessingFeeImportSummary } from "@/lib/actions/csvImport";
import { Link } from "@/i18n/navigation";
import BackHeader from "@/components/shared/BackHeader";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

async function saveReviewWage(uploadId: string, jobId: string, rowId: string, formData: FormData) {
  "use server";
  const wage = formData.get("wage");
  if (typeof wage !== "string") return;
  await resolveLaborImportWage(jobId, rowId, wage);
  revalidatePath(`/more/uploads/${uploadId}`);
  revalidatePath("/more/uploads");
}

export default async function UploadReviewPage({params}: {params: Promise<{uploadId: string}>}) {
  await requireOwnBusiness();
  const {uploadId} = await params;
  const upload = await getUploadReview(uploadId);
  if (!upload) notFound();
  const [t,h,c,csv,locale] = await Promise.all([getTranslations("UploadHistory"),getTranslations("UploadReview"),getTranslations("Common"),getTranslations("CsvImport"),getLocale()]);
  const num = (value: number) => new Intl.NumberFormat(locale).format(value);
  const date = (value: string) => new Intl.DateTimeFormat(locale,{dateStyle:"medium"}).format(new Date(value));
  const title = upload.kind === "sales_csv" ? t("kindSales") : upload.kind === "labor_csv" ? t("kindLabor") : upload.kind === "ingredients_csv" ? t("kindIngredients") : t("kindProcessingFees");
  const summary = upload.summary;
  const sales = upload.kind === "sales_csv" ? summary as SalesImportSummary | null : null;
  const labor = upload.kind === "labor_csv" ? summary as LaborImportSummary | null : null;
  const ingredients = upload.kind === "ingredients_csv" ? summary as IngredientImportSummary | null : null;
  const fees = upload.kind === "processing_fees_csv" ? summary as ProcessingFeeImportSummary | null : null;
  const rejected = sales?.rejectedRows ?? labor?.rejectedRows ?? [];
  const reasons: Record<string,string> = {
    missing_item: csv("rejectedMissingItem"), missing_date: csv("rejectedMissingDate"), invalid_date: csv("rejectedInvalidDate"),
    invalid_quantity: csv("rejectedInvalidQuantity"), invalid_net_sales: csv("rejectedInvalidNetSales"), voided: csv("rejectedVoided"),
    missing_employee: csv("rejectedMissingEmployee"), missing_clock_in: csv("rejectedMissingClockIn"),
    employee_creation_failed: csv("rejectedEmployeeCreationFailed"), duplicate_shift_in_file: csv("rejectedDuplicateShiftInFile"),
  };
  const imported = summary ? "imported" in summary ? summary.imported : "importedDates" in summary ? summary.importedDates : 0 : 0;
  const reupload = upload.kind === "sales_csv" ? "/more/uploads/sales" : upload.kind === "labor_csv" ? "/more/uploads/labor" : upload.kind === "ingredients_csv" ? "/more/uploads/ingredients" : "/more/uploads/processing-fees";
  return <PageShell className="flex flex-col gap-4 px-4 pb-10 pt-6">
    <BackHeader title={h("title")} subtitle={title} backHref="/more/uploads#upload-history" backLabel={c("back")}/>
    <section className="rounded-card-lg bg-card p-5">
      <h1 className="font-headline text-2xl font-bold">{title}</h1><p className="mt-1 text-sm text-ink-muted">{date(upload.createdAt)}</p>
      <p className="mt-3 text-base font-semibold">{summary ? t("rowsLine",{imported:num(imported),rowsInFile:num(summary.rowsInFile)}) : h("noSummary")}</p>
      {(sales?.dateFrom && sales.dateTo || labor?.dateFrom && labor.dateTo || fees?.dateFrom && fees.dateTo) && <p className="text-sm text-ink-muted">{t("dateRangeLine",{dateFrom:(sales?.dateFrom ?? labor?.dateFrom ?? fees?.dateFrom)!,dateTo:(sales?.dateTo ?? labor?.dateTo ?? fees?.dateTo)!})}</p>}
      <p className="mt-1 text-xs text-ink-muted">{h("importedExplanation")}</p>
    </section>
    {rejected.length > 0 && <section className="rounded-card-lg bg-card p-5"><h2 className="text-lg font-bold">{h("skippedTitle")}</h2>
      <p className="mt-1 text-sm text-ink-muted">{h("summaryOnly")}</p>
      <ul className="mt-3 flex flex-col gap-2">{rejected.map((row,index)=><li key={row.reason+index} className="flex justify-between gap-3 rounded-xl bg-warn-tint p-3"><span>{reasons[row.reason] ?? h("otherReason")}</span><span className="shrink-0 font-semibold">{h("rowCount",{count:num(row.count)})}</span></li>)}</ul>
    </section>}
    {sales && sales.skippedToastConflictDates.length > 0 && <section className="rounded-card-lg bg-card p-5">
      <h2 className="text-lg font-bold">{csv("skippedToastTitle")}</h2><p className="text-sm text-ink-muted">{csv("skippedToastHint")}</p>
      <ul className="mt-2 flex flex-wrap gap-2">{sales.skippedToastConflictDates.map(d=><li key={d} className="rounded-full bg-warn-tint px-3 py-1 text-sm">{d}</li>)}</ul></section>}
    {sales && sales.unmatchedItems.length > 0 && <section className="rounded-card-lg bg-card p-5">
      <h2 className="text-lg font-bold">{csv("unmatchedWarningTitle")}</h2><p className="text-sm text-ink-muted">{csv("unmatchedWarningHint")}</p>
      <ul className="my-3 flex flex-col gap-1">{sales.unmatchedItems.map(row=><li key={row.name} className="flex justify-between gap-2"><span>{row.name}</span><span className="text-ink-muted">{h("rowCount",{count:num(row.rows)})}</span></li>)}</ul>
      <Link href={`/menu/import-review?source=upload&uploadId=${upload.id}`} className="inline-flex min-h-12 items-center rounded-full bg-accent px-5 font-bold text-on-accent">{h("matchItems")}</Link>
    </section>}
    {labor && labor.pendingWageReview.length > 0 && <section className="rounded-card-lg bg-card p-5">
      <h2 className="text-lg font-bold">{csv("wageReviewTitle")}</h2><p className="text-sm text-ink-muted">{csv("wageReviewHint")}</p>
      {upload.jobId && labor.pendingWageReview.map(row=><form key={row.rowId} action={saveReviewWage.bind(null,upload.id,upload.jobId!,row.rowId)} className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line p-3">
        <span className="min-w-0 flex-1 font-semibold">{row.employee} — {row.clockInLabel}</span>
        <label className="text-sm">{h("hourlyWage")}<input name="wage" type="number" min="0" step="0.01" required placeholder={csv("wageReviewPlaceholder")} className="mt-1 block h-12 w-24 rounded-xl border border-line px-2"/></label>
        <button type="submit" className="min-h-12 rounded-full bg-accent px-4 font-bold text-on-accent">{csv("wageReviewSave")}</button>
      </form>)}
      <Link className="mt-3 inline-flex min-h-12 items-center font-semibold text-accent-text underline" href="/more/uploads/labor">{csv("matchStaffTitle")}</Link>
    </section>}
    {ingredients && ingredients.newIngredients.length > 0 && <section className="rounded-card-lg bg-card p-5"><h2 className="font-bold">{h("newIngredients")}</h2><ul className="mt-2 flex flex-col gap-1">{ingredients.newIngredients.map(name=><li key={name}>{name}</li>)}</ul></section>}
    {fees && fees.invalidRows > 0 && <section className="rounded-card-lg bg-card p-5"><h2 className="font-bold">{h("skippedTitle")}</h2><p>{h("invalidRows",{count:num(fees.invalidRows)})}</p></section>}
    <Link href={reupload} className="inline-flex min-h-12 items-center justify-center self-start rounded-full border border-line bg-card px-5 font-bold">{h("reupload")}</Link>
  </PageShell>;
}
