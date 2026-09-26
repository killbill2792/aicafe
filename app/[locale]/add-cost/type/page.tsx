import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import TypeExpenseForm from "@/components/addcost/TypeExpenseForm";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function TypeExpensePage() {
  await requireUser();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionType")} backHref="/add-cost" backLabel={tCommon("back")} />
      <TypeExpenseForm
        categoryLabels={categoryLabels}
        todayDateStr={new Date().toISOString().slice(0, 10)}
        labels={{
          amountTitle: t("amountTitle"),
          categoryTitle: t("categoryTitle"),
          vendorLabel: t("vendorLabel"),
          dateLabel: t("dateLabel"),
          save: t("save"),
          saved: t("saved"),
        }}
      />
    </main>
  );
}
