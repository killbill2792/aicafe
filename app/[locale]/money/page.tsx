import { periodCalendarRange } from "@/lib/viewmodels/period";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { readAllPosRows } from "@/lib/pos/pagedReads";
import { salesSourcesForOrders, type SalesOrderEvidence } from "@/components/money/moneyActions";
import { Receipt } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import type { Period } from "@/lib/viewmodels/period";
import { Link } from "@/i18n/navigation";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import AddCostFab from "@/components/shared/AddCostFab";
import MoneyViewSwitch from "@/components/money/MoneyViewSwitch";
import CostRecoveryView from "@/components/money/CostRecoveryView";
import ProfitCostsView from "@/components/money/ProfitCostsView";
import PageShell from "@/components/shared/PageShell";
import { isValidMonthKey } from "@/lib/viewmodels/monthCalendar";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; view?: string; calMonth?: string }>;
}) {
  const user = await requireOwnBusiness();
  const { period: periodParam, view: viewParam, calMonth: calMonthParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "month";
  const view = viewParam === "profit" ? "profit" : "recovery";

  const snapshot = await getSnapshot(period);
  const t = await getTranslations("Money");
  let toastConnected = false;
  let salesSources: ReturnType<typeof salesSourcesForOrders> = ["unknown"];
  if (user && isSupabaseConfigured()) {
    const db = await createServerSupabaseClient();
    const businessId = await getActiveBusinessId(user.id);
    const range = periodCalendarRange(snapshot, period);
    const orders = await readAllPosRows<SalesOrderEvidence>((first, last) => db.from("orders")
      .select("pos_order_id, processing_fee_provider")
      .eq("business_id", businessId).eq("toast_excluded",false).is("superseded_by",null).gte("business_date", range.start)
      .lte("business_date", range.end).order("id").range(first, last), "money sales sources");
    salesSources = salesSourcesForOrders(orders);
    // Toast credentials have no authenticated RLS grants. Only read a verified
    // state after the user's active-business membership has been checked.
    if (process.env.SUPABASE_SERVICE_ROLE_KEY && businessId === snapshot.business.id) {
      const admin = createAdminSupabaseClient();
      const { data: credentials } = await admin.from("toast_api_credentials")
        .select("state").eq("business_id", businessId).maybeSingle();
      if (credentials?.state === "verified") {
        const { data: location } = await admin.from("toast_location_mappings")
          .select("verified_at").eq("business_id", businessId).not("verified_at", "is", null).limit(1);
        toastConnected = Boolean(location?.length);
      }
    }
  }
  // Never past the current calendar month — "previous months" navigation only goes backward.
  const calMonthKey = isValidMonthKey(calMonthParam) && calMonthParam <= snapshot.monthKey ? calMonthParam : snapshot.monthKey;

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
        </div>
      </header>

      <MoneyViewSwitch current={view} recoveryLabel={t("recoveryTab")} profitLabel={t("profitTab")} />

      {view === "profit" && <PeriodSwitch current={period} />}

      {view === "recovery" ? (
        <CostRecoveryView snapshot={snapshot} calMonthKey={calMonthKey} toastConnected={toastConnected} />
      ) : (
        <ProfitCostsView snapshot={snapshot} period={period} salesSources={salesSources} />
      )}

      <AddCostFab />
    </PageShell>
  );
}
