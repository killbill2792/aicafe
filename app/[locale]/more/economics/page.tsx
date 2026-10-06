import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getProfitGoalSimulatorData } from "@/lib/data/getProfitGoalSimulatorData";
import BackHeader from "@/components/shared/BackHeader";
import ProfitGoalSimulator from "@/components/more/ProfitGoalSimulator";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

export default async function EconomicsPage() {
  await requireOwnBusiness();
  const [data, t, tCommon] = await Promise.all([
    getProfitGoalSimulatorData(),
    getTranslations("Economics"),
    getTranslations("Common"),
  ]);

  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <ProfitGoalSimulator
        data={data}
        labels={{
          currentMargin: t("currentMargin"),
          currentMarginMissing: t("currentMarginMissing"),
          actual: t("actual"),
          estimated: t("estimated"),
          targetMargin: t("targetMargin"),
          targetMarginHint: t("targetMarginHint"),
          run: t("run"),
          simulationOnly: t("simulationOnly"),
          assumption: t("assumption"),
          readyMeetsTarget: t("readyMeetsTarget"),
          readyNeedsIncrease: t("readyNeedsIncrease"),
          largeChange: t("largeChange"),
          unavailableSales: t("unavailableSales"),
          unavailableFees: t("unavailableFees"),
          unavailableCosts: t("unavailableCosts"),
          targetTested: t("targetTested"),
          item: t("item"),
          productCost: t("productCost"),
          productCostPct: t("productCostPct"),
          currentPrice: t("currentPrice"),
          simulatedPrice: t("simulatedPrice"),
          change: t("change"),
          unavailableItem: t("unavailableItem"),
          invalid: t("invalid"),
          targetNotFeasible: t("targetNotFeasible"),
        }}
      />
    </PageShell>
  );
}
