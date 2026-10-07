import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getProcessingFeeEstimateSetup } from "@/lib/data/getProcessingFeeEstimateSetup";
import BackHeader from "@/components/shared/BackHeader";
import ProcessingFeeEstimateForm from "@/components/more/ProcessingFeeEstimateForm";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

export default async function ProcessingFeesPage() {
  await requireOwnBusiness();
  const [setup, t, tCommon] = await Promise.all([
    getProcessingFeeEstimateSetup(),
    getTranslations("ProcessingFees"),
    getTranslations("Common"),
  ]);

  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <ProcessingFeeEstimateForm
        plan={setup.plan}
        today={setup.today}
        coverage={setup.coverage}
        sourceSummary={setup.sourceSummary}
        labels={{
          assumptionBanner: t("assumptionBanner"),
          automaticTitle: t("automaticTitle"),
          connectedSource: t("connectedSource"),
          actualCoverage: t("actualCoverage"),
          completeActualCoverage: t("completeActualCoverage"),
          missingCoverage: t("missingCoverage"),
          actualFirstNote: t("actualFirstNote"),
          uploadActual: t("uploadActual"),
          estimateTitle: t("estimateTitle"),
          estimateIntro: t("estimateIntro"),
          processor: t("processor"),
          processorPlaceholder: t("processorPlaceholder"),
          processorHelp: t("processorHelp"),
          effectiveFrom: t("effectiveFrom"),
          effectiveFromHelp: t("effectiveFromHelp"),
          processedSalesShare: t("processedSalesShare"),
          processedSalesShareHint: t("processedSalesShareHint"),
          processedSalesShareHelp: t("processedSalesShareHelp"),
          processedTransactionShare: t("processedTransactionShare"),
          processedTransactionShareHint: t("processedTransactionShareHint"),
          processedTransactionShareHelp: t("processedTransactionShareHelp"),
          averageTicket: t("averageTicket"),
          averageTicketHint: t("averageTicketHint"),
          averageTicketHelp: t("averageTicketHelp"),
          orderCountsAutomatic: t("orderCountsAutomatic"),
          rulesTitle: t("rulesTitle"),
          rulesHint: t("rulesHint"),
          ruleLabel: t("ruleLabel"),
          ruleLabelPlaceholder: t("ruleLabelPlaceholder"),
          percentageRate: t("percentageRate"),
          percentageRateHelp: t("percentageRateHelp"),
          fixedFee: t("fixedFee"),
          fixedFeeHelp: t("fixedFeeHelp"),
          salesMix: t("salesMix"),
          salesMixHelp: t("salesMixHelp"),
          transactionMix: t("transactionMix"),
          transactionMixHelp: t("transactionMixHelp"),
          standardRate: t("standardRate"),
          advanced: t("advanced"),
          advancedHint: t("advancedHint"),
          remove: t("remove"),
          addRule: t("addRule"),
          save: t("save"),
          saving: t("saving"),
          saved: t("saved"),
          coverageTitle: t("coverageTitle"),
          coverageActual: t("coverageActual"),
          coverageEstimated: t("coverageEstimated"),
          coverageMissing: t("coverageMissing"),
          coverageSalesDays: t("coverageSalesDays"),
          incompleteWarning: t("incompleteWarning"),
        }}
      />
    </PageShell>
  );
}
