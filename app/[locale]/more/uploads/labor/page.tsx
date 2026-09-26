import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import BackHeader from "@/components/shared/BackHeader";
import LaborCsvImporter from "@/components/uploads/LaborCsvImporter";
import type { LaborColumnMapping } from "@/lib/pos/csv/parseLaborCsv";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function LaborCsvPage() {
  await requireUser();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");
  const initialMapping = (await getSavedMapping("labor")) as LaborColumnMapping | null;

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("laborTitle")} subtitle={t("laborSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <LaborCsvImporter
        initialMapping={initialMapping}
        labels={{
          uploadPrompt: t("uploadPrompt"),
          chooseFile: t("chooseFile"),
          mapTitle: t("mapTitle"),
          fieldLabels: { employee: t("fieldEmployee"), date: t("fieldDate"), clockIn: t("fieldClockIn"), clockOut: t("fieldClockOut"), hourlyWage: t("fieldHourlyWage") },
          none: t("none"),
          preview: t("laborPreview"),
          import: t("import"),
          imported: t("imported"),
        }}
      />
    </main>
  );
}
