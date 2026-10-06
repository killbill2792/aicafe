import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import BackHeader from "@/components/shared/BackHeader";
import PageShell from "@/components/shared/PageShell";
import ProcessingFeeImporter from "@/components/uploads/ProcessingFeeImporter";
import type { ProcessingFeeColumnMapping } from "@/lib/pos/csv/parseProcessingFeesCsv";

export const dynamic = "force-dynamic";

export default async function ProcessingFeesUploadPage() {
  await requireOwnBusiness();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");
  const initialMapping = (await getSavedMapping("processing_fees")) as ProcessingFeeColumnMapping | null;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("processingFeesTitle")} subtitle={t("processingFeesSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <ProcessingFeeImporter initialMapping={initialMapping} labels={{
        uploadPrompt: t("processingFeesUploadPrompt"), chooseFile: t("chooseFile"), mapTitle: t("mapTitle"),
        fieldDate: t("fieldDate"), fieldProcessingFee: t("fieldProcessingFee"), none: t("none"),
        preview: t("processingFeesPreview"), import: t("import"), imported: t("processingFeesImported"),
        result: t("processingFeesResult"), invalid: t("processingFeesInvalid"),
      }} />
    </PageShell>
  );
}
