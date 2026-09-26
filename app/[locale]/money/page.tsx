import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import type { Period } from "@/lib/viewmodels/period";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import AddCostFab from "@/components/shared/AddCostFab";
import MoneyViewSwitch from "@/components/money/MoneyViewSwitch";
import CostRecoveryView from "@/components/money/CostRecoveryView";
import ProfitCostsView from "@/components/money/ProfitCostsView";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; view?: string }>;
}) {
  await requireUser();
  const { period: periodParam, view: viewParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "month";
  const view = viewParam === "profit" ? "profit" : "recovery";

  const snapshot = await getSnapshot();
  const t = await getTranslations("Money");

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium text-ink-muted">{snapshot.todayDateStr}</div>
          <div className="text-[22px] font-bold text-ink">{snapshot.business.name}</div>
        </div>
        <LanguageSwitch href="/money" />
      </header>

      <MoneyViewSwitch current={view} recoveryLabel={t("recoveryTab")} profitLabel={t("profitTab")} />

      {view === "profit" && <PeriodSwitch current={period} />}

      {view === "recovery" ? <CostRecoveryView snapshot={snapshot} /> : <ProfitCostsView snapshot={snapshot} period={period} />}

      <AddCostFab />
    </main>
  );
}
