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
        labels={{
          assumptionBanner: t("assumptionBanner"),
          processor: t("processor"),
          processorPlaceholder: t("processorPlaceholder"),
          effectiveFrom: t("effectiveFrom"),
          processedSalesShare: t("processedSalesShare"),
          processedSalesShareHint: t("processedSalesShareHint"),
          processedTransactionShare: t("processedTransactionShare"),
          processedTransactionShareHint: t("processedTransactionShareHint"),
          averageTicket: t("averageTicket"),
          averageTicketHint: t("averageTicketHint"),
          rulesTitle: t("rulesTitle"),
          rulesHint: t("rulesHint"),
          ruleLabel: t("ruleLabel"),
          ruleLabelPlaceholder: t("ruleLabelPlaceholder"),
          percentageRate: t("percentageRate"),
          fixedFee: t("fixedFee"),
          salesMix: t("salesMix"),
          transactionMix: t("transactionMix"),
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
