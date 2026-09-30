import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getRecurringCosts } from "@/lib/data/getRecurringCosts";
import BackHeader from "@/components/shared/BackHeader";
import BillsManager from "@/components/bills/BillsManager";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function BillsPage() {
  await requireOwnBusiness();
  const bills = await getRecurringCosts();
  const t = await getTranslations("Bills");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <BillsManager
        bills={bills}
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
    </main>
  );
}
