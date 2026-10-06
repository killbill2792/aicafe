import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getOwnerEconomicsSettings } from "@/lib/data/getOwnerEconomicsSettings";
import BackHeader from "@/components/shared/BackHeader";
import OwnerEconomicsForm from "@/components/more/OwnerEconomicsForm";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

export default async function EconomicsPage() {
  await requireOwnBusiness();
  const [settings, t, tCommon] = await Promise.all([
    getOwnerEconomicsSettings(),
    getTranslations("Economics"),
    getTranslations("Common"),
  ]);

  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <OwnerEconomicsForm
        settings={settings}
        labels={{
          currentMargin: t("currentMargin"),
          currentMarginMissing: t("currentMarginMissing"),
          actual: t("actual"),
          estimated: t("estimated"),
          targetMargin: t("targetMargin"),
          targetMarginHint: t("targetMarginHint"),
          defaultAssumption: t("defaultAssumption"),
          ownerConfirmed: t("ownerConfirmed"),
          payrollBurden: t("payrollBurden"),
          payrollBurdenHint: t("payrollBurdenHint"),
          payrollEstimated: t("payrollEstimated"),
          scenarioTitle: t("scenarioTitle"),
          scenarioHint: t("scenarioHint"),
          scenarioNoHistory: t("scenarioNoHistory"),
          item: t("item"),
          productCost: t("productCost"),
          currentPrice: t("currentPrice"),
          suggestedPrice: t("suggestedPrice"),
          change: t("change"),
          save: t("save"),
          saving: t("saving"),
          saved: t("saved"),
          invalid: t("invalid"),
        }}
      />
    </PageShell>
  );
}
