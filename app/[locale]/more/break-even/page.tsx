import { Coins, TrendingUp, Users, Milk } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildBreakEvenViewModel } from "@/lib/viewmodels/breakEvenViewModel";
import BackHeader from "@/components/shared/BackHeader";
import Money from "@/components/shared/Money";
import { formatCents } from "@/lib/calc";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

const WHATIF_ICONS: Record<string, { Icon: typeof TrendingUp; bg: string; fg: string }> = {
  price: { Icon: TrendingUp, bg: "bg-good-tint", fg: "text-good" },
  staffing: { Icon: Users, bg: "bg-[#E8EEF5]", fg: "text-staff" },
  milk: { Icon: Milk, bg: "bg-warn-tint", fg: "text-warn" },
};

export default async function BreakEvenPage() {
  await requireOwnBusiness();
  const snapshot = await getSnapshot();
  const vm = buildBreakEvenViewModel(snapshot);
  const t = await getTranslations("BreakEven");
  const tCommon = await getTranslations("Common");

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />

      <section className="flex flex-col items-center gap-2 rounded-card-lg bg-card p-[22px] text-center">
        <span className="text-base font-semibold text-ink-muted">{t("everyDay")}</span>
        <span className="font-headline text-money-lg font-bold leading-none text-staff">
          {Number.isFinite(vm.drinksNeededPerDay) ? vm.drinksNeededPerDay : "—"}
        </span>
        <span className="text-lg font-bold">{t("drinksToCover")}</span>
        <span className="text-sm text-ink-muted">{t("aboutPerHour", { count: vm.perHour })}</span>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-[17px] font-bold">{t("whereFrom")}</h2>
        <div className="flex items-center gap-3 text-[15px]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-running text-ink">
            <Coins aria-hidden="true" size={18} />
          </span>
          <span className="flex-1">{t("rentBillsRow")}</span>
          <span className="font-bold">{t("perDay", { amount: formatCents(vm.runningPerDayCents) })}</span>
        </div>
        <div className="flex items-center gap-3 text-[15px]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-staff text-white">
            <Users aria-hidden="true" size={18} />
          </span>
          <span className="flex-1">{t("plannedStaffRow")}</span>
          <span className="font-bold">{t("perDay", { amount: formatCents(vm.avgDailyStaffCostCents) })}</span>
        </div>
        <div className="h-px bg-[#EFE7DB]" />
        <div className="flex items-center gap-3 text-[15px]">
          <span className="flex-1 font-semibold">{t("eachDrinkLeaves")}</span>
          <span className="font-bold text-good">
            <Money cents={vm.avgMoneyLeftPerDrinkCents} />
          </span>
        </div>
        <div className="rounded-[10px] bg-[#FAF6F0] px-3 py-2.5 text-sm text-ink-muted">
          {formatCents(vm.dailyCostsToCoverCents)} ÷ {formatCents(vm.avgMoneyLeftPerDrinkCents)} ={" "}
          {Number.isFinite(vm.drinksNeededPerDay) ? t("drinksCount", { count: vm.drinksNeededPerDay }) : "—"}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-[17px] font-bold">{t("whatIf")}</h2>
        {vm.whatIfs.map((w) => {
          const icon = WHATIF_ICONS[w.key];
          const Icon = icon.Icon;
          const better = w.needed < vm.drinksNeededPerDay;
          return (
            <div key={w.key} className="flex items-center gap-3 rounded-2xl bg-[#FAF6F0] p-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${icon.bg} ${icon.fg}`}>
                <Icon aria-hidden="true" size={20} />
              </span>
              <span className="flex-1 text-[15px] font-semibold">{t(`whatIf_${w.key}`)}</span>
              <span className={`text-lg font-bold ${better ? "text-good" : "text-warn"}`}>{Number.isFinite(w.needed) ? w.needed : "—"}</span>
            </div>
          );
        })}
        <span className="text-[13px] text-ink-muted">{t("whatIfFooter")}</span>
      </section>
    </PageShell>
  );
}
