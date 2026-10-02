import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import { getEmployees } from "@/lib/data/getEmployees";
import BackHeader from "@/components/shared/BackHeader";
import LaborCsvImporter from "@/components/uploads/LaborCsvImporter";
import type { LaborColumnMapping } from "@/lib/pos/csv/parseLaborCsv";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function LaborCsvPage() {
  await requireOwnBusiness();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");
  const [initialMapping, employees] = await Promise.all([getSavedMapping("labor") as Promise<LaborColumnMapping | null>, getEmployees()]);
  const existingEmployees = employees.map((e) => ({ id: e.id, name: e.name }));

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("laborTitle")} subtitle={t("laborSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <LaborCsvImporter
        initialMapping={initialMapping}
        existingEmployees={existingEmployees}
        labels={{
          uploadPrompt: t("uploadPrompt"),
          chooseFile: t("chooseFile"),
          mapTitle: t("mapTitle"),
          fieldLabels: { employee: t("fieldEmployee"), date: t("fieldDate"), clockIn: t("fieldClockIn"), clockOut: t("fieldClockOut"), hourlyWage: t("fieldHourlyWage") },
          none: t("none"),
          preview: t("laborPreview"),
          import: t("import"),
          imported: t("imported"),
          resultSummary: t("resultSummary"),
          resultSummaryNoDates: t("resultSummaryNoDates"),
          matchStaffTitle: t("matchStaffTitle"),
          matchStaffHint: t("matchStaffHint"),
          addAsNewEmployee: t("addAsNewEmployee"),
        }}
      />
    </PageShell>
  );
}
