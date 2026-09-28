import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import BackHeader from "@/components/shared/BackHeader";
import SalesCsvImporter from "@/components/uploads/SalesCsvImporter";
import type { SalesColumnMapping } from "@/lib/pos/csv/parseSalesCsv";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function SalesCsvPage() {
  await requireOwnBusiness();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");
  const initialMapping = (await getSavedMapping("sales")) as SalesColumnMapping | null;

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("salesTitle")} subtitle={t("salesSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <SalesCsvImporter
        initialMapping={initialMapping}
        labels={{
          uploadPrompt: t("uploadPrompt"),
          chooseFile: t("chooseFile"),
          mapTitle: t("mapTitle"),
          fieldLabels: { date: t("fieldDate"), item: t("fieldItem"), quantity: t("fieldQuantity"), netSales: t("fieldNetSales"), category: t("fieldCategory") },
          none: t("none"),
          preview: t("salesPreview"),
          import: t("import"),
          imported: t("imported"),
        }}
      />
    </main>
  );
}
