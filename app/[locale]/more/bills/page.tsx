import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getRecurringCosts } from "@/lib/data/getRecurringCosts";
import BackHeader from "@/components/shared/BackHeader";
import BillsManager from "@/components/bills/BillsManager";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import PageShell from "@/components/shared/PageShell";
import { isBillCategory } from "@/lib/expenses/expectedCosts";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function BillsPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  await requireOwnBusiness();
  const [{ category }, bills] = await Promise.all([searchParams, getRecurringCosts()]);
  const t = await getTranslations("Bills");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <BillsManager
        bills={bills}
        initialCategory={EXPENSE_CATEGORY_CODES.includes(category as ExpenseCategoryCode) && isBillCategory(category as ExpenseCategoryCode) ? category as ExpenseCategoryCode : null}
        categoryLabels={categoryLabels}
        labels={{
          amountLabel: t("amountLabel"),
          dueDayLabel: t("dueDayLabel"),
          labelLabel: t("labelLabel"),
          labelPlaceholder: t("labelPlaceholder"),
          save: t("save"),
          delete: t("delete"),
          addHint: t("addHint"),
          edit: t("edit"),
          addAnother: t("addAnother"),
        }}
      />
    </PageShell>
  );
}
