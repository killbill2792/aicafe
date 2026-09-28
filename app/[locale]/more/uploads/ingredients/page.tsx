import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSavedMapping } from "@/lib/actions/csvImport";
import { getIngredientNames } from "@/lib/data/getIngredientNames";
import { getSnapshot } from "@/lib/data/getSnapshot";
import BackHeader from "@/components/shared/BackHeader";
import IngredientCostImporter from "@/components/uploads/IngredientCostImporter";
import type { IngredientCostColumnMapping } from "@/lib/pos/csv/parseIngredientCostsCsv";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function IngredientCostsPage() {
  await requireOwnBusiness();
  const t = await getTranslations("CsvImport");
  const tCommon = await getTranslations("Common");

  const [initialMapping, existingNames, snapshot] = await Promise.all([
    getSavedMapping("ingredients") as Promise<IngredientCostColumnMapping | null>,
    getIngredientNames(),
    getSnapshot(),
  ]);

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("ingredientsTitle")} subtitle={t("ingredientsSubtitle")} backHref="/more/uploads" backLabel={tCommon("back")} />
      <IngredientCostImporter
        initialMapping={initialMapping}
        existingNames={existingNames}
        todayDateStr={snapshot.todayDateStr}
        labels={{
          uploadPrompt: t("ingredientsUploadPrompt"),
          chooseFile: t("chooseFile"),
          mapTitle: t("mapTitle"),
          fieldLabels: { name: t("fieldIngredientName"), costPerUnit: t("fieldCostPerUnit"), unitNote: t("fieldUnitNote"), effectiveDate: t("fieldEffectiveDate") },
          none: t("none"),
          preview: t("ingredientsPreview"),
          import: t("import"),
          imported: t("imported"),
          newIngredientsTitle: t("newIngredientsTitle"),
          newIngredientsHint: t("newIngredientsHint"),
          unitG: t("unitG"),
          unitMl: t("unitMl"),
          unitEach: t("unitEach"),
        }}
      />
    </main>
  );
}
