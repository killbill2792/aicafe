import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import TypeExpenseForm from "@/components/addcost/TypeExpenseForm";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";
import PageShell from "@/components/shared/PageShell";
import { validCostCategory, validReturnTo } from "@/components/addcost/routeParams";
import {getSnapshot} from "@/lib/data/getSnapshot";
import {cafeToday} from "@/lib/metrics/core/clock";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function TypeExpensePage({ searchParams }: { searchParams: Promise<{ category?: string; returnTo?: string }> }) {
  await requireOwnBusiness();
  const [{ category, returnTo }, t] = await Promise.all([searchParams, getTranslations("AddCost")]);
  const tCommon = await getTranslations("Common");
  const snapshot = await getSnapshot();
  const today = cafeToday(snapshot.business.timezone);
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionType")} backHref="/add-cost" backLabel={tCommon("back")} />
      <TypeExpenseForm key={category ?? "none"}
        currency={snapshot.business.currency} currencyMissingLabel={tCommon("currencyNotSet")}
        returnTo={validReturnTo(returnTo)}
        initialCategory={validCostCategory(category)}
        categoryLabels={categoryLabels}
        todayDateStr={today}
        labels={{
          backspace: t("backspace"),
          saveError: t("manualSaveError"),
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
