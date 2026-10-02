import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import TypeExpenseForm from "@/components/addcost/TypeExpenseForm";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function TypeExpensePage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  await requireOwnBusiness();
  const [{ category }, t] = await Promise.all([searchParams, getTranslations("AddCost")]);
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionType")} backHref="/add-cost" backLabel={tCommon("back")} />
      <TypeExpenseForm
        initialCategory={EXPENSE_CATEGORY_CODES.includes(category as ExpenseCategoryCode) ? category as ExpenseCategoryCode : null}
        categoryLabels={categoryLabels}
        todayDateStr={new Date().toISOString().slice(0, 10)}
        labels={{
          amountTitle: t("amountTitle"),
          categoryTitle: t("categoryTitle"),
          vendorLabel: t("vendorLabel"),
          dateLabel: t("dateLabel"),
          save: t("save"),
          saved: t("saved"),
          customLabelLabel: t("customLabelLabel"),
          customLabelHint: t("customLabelHint"),
        }}
      />
    </PageShell>
  );
}
