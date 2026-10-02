import { Receipt } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import type { Period } from "@/lib/viewmodels/period";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import AddCostFab from "@/components/shared/AddCostFab";
import MoneyViewSwitch from "@/components/money/MoneyViewSwitch";
import CostRecoveryView from "@/components/money/CostRecoveryView";
import ProfitCostsView from "@/components/money/ProfitCostsView";
import PageShell from "@/components/shared/PageShell";

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
  await requireOwnBusiness();
  const { period: periodParam, view: viewParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "month";
  const view = viewParam === "profit" ? "profit" : "recovery";

  const snapshot = await getSnapshot();
  const t = await getTranslations("Money");

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-44 pt-6 md:pb-16">
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium text-ink-muted">{snapshot.todayDateStr}</div>
          <div className="text-[22px] font-bold text-ink">{snapshot.business.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/more/bills" className="flex min-h-12 items-center gap-1.5 rounded-full border border-line px-3.5 text-sm font-bold text-ink no-underline">
            <Receipt aria-hidden="true" size={17} /> {t("manageBills")}
          </Link>
          <LanguageSwitch href="/money" />
        </div>
      </header>

      <MoneyViewSwitch current={view} recoveryLabel={t("recoveryTab")} profitLabel={t("profitTab")} />

      {view === "profit" && <PeriodSwitch current={period} />}

      {view === "recovery" ? <CostRecoveryView snapshot={snapshot} /> : <ProfitCostsView snapshot={snapshot} period={period} />}

      <AddCostFab />
    </PageShell>
  );
}
