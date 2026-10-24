import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import StatementUploader from "@/components/addcost/StatementUploader";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";
import PageShell from "@/components/shared/PageShell";
import { validReturnTo } from "@/components/addcost/routeParams";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function StatementUploadPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  await requireOwnBusiness();
  const { returnTo } = await searchParams;
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionStatement")} backHref="/add-cost" backLabel={tCommon("back")} />
      <StatementUploader returnTo={validReturnTo(returnTo)}
        categoryLabels={categoryLabels}
        labels={{
          uploadPrompt: t("statementUploadPrompt"),
          chooseFile: t("statementChooseFile"),
          reading: t("statementReading"),
          saveAll: t("statementSaveAll"),
          saved: t("saved"),
          balanceOk: t("statementBalanceOk"),
          balanceMismatch: t("statementBalanceMismatch"),
          lowConfidence: t("statementLowConfidence"),
          exclude: t("statementExclude"),
          addMissingLine: t("statementAddMissingLine"),
          missingLineHint: t("statementMissingLineHint"),
          missingDescription: t("statementMissingDescription"),
          missingAmount: t("statementMissingAmount"),
          missingDate: t("statementMissingDate"),
          missingCategory: t("statementMissingCategory"),
          missingConfirm: t("statementMissingConfirm"),
          missingCancel: t("statementMissingCancel"),
          saveError: t("statementSaveError"),
          readError: t("statementReadError"),
          tryAgain: t("statementTryAgain"),
        }}
      />
    </PageShell>
  );
}
