import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import BackHeader from "@/components/shared/BackHeader";
import SalesCsvImporter from "@/components/uploads/SalesCsvImporter";
import type { SalesColumnMapping } from "@/lib/pos/csv/parseSalesCsv";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function SalesCsvPage() {
  await requireOwnBusiness();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");
  const initialMapping = (await getSavedMapping("sales")) as SalesColumnMapping | null;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("salesTitle")} subtitle={t("salesSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <SalesCsvImporter
        initialMapping={initialMapping}
        labels={{
          uploadPrompt: t("uploadPrompt"),
          chooseFile: t("chooseFile"),
          mapTitle: t("mapTitle"),
          fieldLabels: { date: t("fieldDate"), item: t("fieldItem"), quantity: t("fieldQuantity"), netSales: t("fieldNetSales"), category: t("fieldCategory"), processingFee: t("fieldSalesProcessingFee") },
          none: t("none"),
          preview: t("salesPreview"),
          import: t("import"),
          imported: t("imported"),
          resultSummary: t("resultSummary"),
          resultSummaryNoDates: t("resultSummaryNoDates"),
          unmatchedWarningTitle: t("unmatchedWarningTitle"),
          unmatchedWarningHint: t("unmatchedWarningHint"),
          unmatchedRowsCount: t("unmatchedRowsCount"),
          reviewRowsInFile: t("reviewRowsInFile"),
          rejectedTitle: t("rejectedTitle"),
          rejectedReasons: {
            missing_item: t("rejectedMissingItem"),
            missing_date: t("rejectedMissingDate"),
            invalid_date: t("rejectedInvalidDate"),
            invalid_quantity: t("rejectedInvalidQuantity"),
            invalid_net_sales: t("rejectedInvalidNetSales"),
          },
          statusStarting: t("statusStarting"),
          statusFinalizing: t("statusFinalizing"),
          duplicateNotice: t("duplicateNotice"),
          skippedToastTitle: t("skippedToastTitle"),
          skippedToastHint: t("skippedToastHint"),
          tryAgain: t("tryAgain"),
          cancelStuckImport: t("cancelStuckImport"),
          errors: {
            not_signed_in: t("errorNotSignedIn"),
            row_limit_source: t("errorRowLimitSource"),
            row_limit_groups: t("errorRowLimitGroups"),
            row_limit_shifts: t("errorRowLimitShifts"),
            no_valid_rows: t("errorNoValidRows"),
            already_processing_duplicate: t("errorAlreadyProcessingDuplicate"),
            already_running: t("errorAlreadyRunning"),
            create_job_failed: t("errorCreateJobFailed"),
            staging_failed: t("errorStagingFailed"),
            job_not_found: t("errorJobNotFound"),
            finalize_failed: t("errorFinalizeFailed"),
            wage_invalid: t("errorWageInvalid"),
            wage_update_failed: t("errorWageUpdateFailed"),
            still_within_window: t("errorStillWithinWindow"),
          },
        }}
      />
    </PageShell>
  );
}
