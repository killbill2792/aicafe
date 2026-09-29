import { TrendingDown, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Money from "@/components/shared/Money";
import EstimatePill from "@/components/shared/EstimatePill";
import { Link } from "@/i18n/navigation";
import type { HealthBand } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import type { Period } from "@/lib/viewmodels/period";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";

const BAND_COLOR: Record<HealthBand, string> = { healthy: "text-good", watch: "text-warn", high: "text-warn" };

function StepBar({ label, cents, widthPct, color, bold }: { label: string; cents: number; widthPct: number; color: string; bold?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-[78px] shrink-0 text-[13px] font-semibold ${bold ? "text-good" : "text-ink-muted"}`}>{label}</span>
      <div className="h-[26px] flex-1">
        <div className={`h-[26px] rounded-md ${color}`} style={{ width: `${Math.max(0, Math.min(100, widthPct))}%` }} />
      </div>
      <span className={`w-16 shrink-0 text-end text-[13px] font-bold ${bold ? "text-good" : ""}`}>
        {cents < 0 ? "−" : ""}
        <Money cents={Math.abs(cents)} />
      </span>
    </div>
  );
}

function HealthRow({ label, pct, band, note, bandLabel }: { label: string; pct: number; band: HealthBand; note: string; bandLabel: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[15px]">
        <span className="font-semibold">{label}</span>
        <span className={`font-bold ${BAND_COLOR[band]}`}>
          {Math.round(pct)}% · {bandLabel}
        </span>
      </div>
      <div className="relative h-3 rounded-md bg-[#F1EAE0]">
        <div
          className="absolute top-0 h-3 rounded-md bg-[#CFE3D6]"
          style={{ insetInlineStart: `${band === "high" ? 0 : 50}%`, width: `${band === "high" ? 60 : 20}%` }}
        />
        <div
          className={`absolute -top-[3px] h-[18px] w-[18px] rounded-full border-[3px] border-card ${band === "healthy" ? "bg-good" : "bg-warn"}`}
          style={{ insetInlineStart: `calc(${Math.max(0, Math.min(96, pct))}% - 9px)` }}
        />
      </div>
      <span className="text-xs text-ink-muted">{note}</span>
    </div>
  );
}

export default async function ProfitCostsView({ snapshot, period }: { snapshot: BusinessSnapshot; period: Period }) {
  const t = await getTranslations("Money");
  const bandLabel: Record<HealthBand, string> = { healthy: t("bandHealthy"), watch: t("bandWatch"), high: t("bandHigh") };
  const vm = buildProfitAndCostsViewModel(snapshot, period);
  // "% of sales" is meaningless with $0 sales — the old `Math.max(1, ...)` cents-floor made a
  // real (period-prorated) running-cost total divide against a fake 1¢ of sales, producing
  // nonsense like "150200000%" the moment a period had no sales yet. 0% reads as "not enough
  // sales to show a ratio" rather than a fabricated number.
  const pct = (n: number) => (vm.salesCents > 0 ? (n / vm.salesCents) * 100 : 0);
  const runningExCardFees = vm.runningCostLines.reduce((s, l) => s + l.amountCents, 0);

  const changeLabels: Record<string, string> = {
    sales: t("sales"),
    ingredients: t("ingredients"),
    staff: t("staff"),
    ownerProfit: t("ownerProfit"),
  };

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-col gap-3.5 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-base font-bold">{t("fromSalesToPocket")}</h2>
        <div className="flex flex-col gap-2">
          <StepBar label={t("sales")} cents={vm.salesCents} widthPct={100} color="bg-ink" />
          <StepBar label={t("ingredients")} cents={-vm.ingredientsCents} widthPct={pct(vm.ingredientsCents)} color="bg-ingredients" />
          <StepBar label={t("staff")} cents={-(vm.wagesCents + vm.staffTaxCents)} widthPct={pct(vm.wagesCents + vm.staffTaxCents)} color="bg-staff" />
          <StepBar
            label={t("rentAndBills")}
            cents={-(vm.totalCostsCents - vm.ingredientsCents - vm.wagesCents - vm.staffTaxCents)}
            widthPct={pct(vm.totalCostsCents - vm.ingredientsCents - vm.wagesCents - vm.staffTaxCents)}
            color="bg-running"
          />
          <StepBar label={t("youKeep")} cents={vm.ownerProfitCents} widthPct={pct(vm.ownerProfitCents)} color="bg-good" bold />
        </div>
      </section>

      <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-1.5">
        <div className="flex items-center justify-between border-b-2 border-ink py-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[17px] font-extrabold">{t("sales")}</span>
            <span className="text-xs text-ink-muted">{t("fromSquare")}</span>
          </div>
          <span className="text-xl font-extrabold">
            <Money cents={vm.salesCents} />
          </span>
        </div>

        <RowGroup label={t("ingredients")} pct={Math.round(pct(vm.ingredientsCents))} color="bg-ingredients">
          <Row name={t("ingredientsAndCups")} cents={vm.ingredientsCents} addLabel={t("add")} />
        </RowGroup>

        <RowGroup label={t("staff")} pct={Math.round(pct(vm.wagesCents + vm.staffTaxCents))} color="bg-staff">
          <Row name={t("wages")} cents={vm.wagesCents} addLabel={t("add")} />
          <Row name={t("payrollTaxes")} cents={vm.staffTaxCents} addLabel={t("add")} last />
        </RowGroup>

        <RowGroup label={t("runningCosts")} pct={Math.round(pct(runningExCardFees + vm.cardFeesCents))} color="bg-running">
          <Row name={t("cardFees")} cents={vm.cardFeesCents} addLabel={t("add")} />
          {vm.runningCostLines.map((line, i) => (
            <Row
              key={line.categoryCode}
              name={line.label}
              cents={line.isMissing ? null : line.amountCents}
              estimate={line.isEstimate}
              estimateLabel={t("estimateLower")}
              addLabel={t("add")}
              last={i === vm.runningCostLines.length - 1}
            />
          ))}
        </RowGroup>

        <div className="flex items-center justify-between py-3.5">
          <span className="text-base font-extrabold">{t("totalCosts")}</span>
          <span className="text-lg font-extrabold text-warn">
            <Money cents={vm.totalCostsCents} />
          </span>
        </div>
        <div className="mx-[-6px] mb-1.5 flex items-center justify-between rounded-2xl bg-good-tint px-3.5 py-3">
          <span className="text-[17px] font-extrabold text-[#1E4D37]">{t("ownerProfit")}</span>
          <span className="font-headline text-[28px] font-bold text-good">
            <Money cents={vm.ownerProfitCents} />
          </span>
        </div>
      </section>

      <p className="mx-1 text-sm text-ink-muted">{t("costsEntered", { entered: vm.costsEnteredCount, total: vm.costsTotalCount })}</p>

      <section className="flex flex-col gap-3.5 rounded-card-lg bg-card p-[18px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[17px] font-bold">{t("healthCheck")}</span>
          <span className="text-[13px] text-ink-muted">{t("healthCheckSubtitle")}</span>
        </div>
        <HealthRow label={t("ingredients")} pct={vm.ingredientsRatio * 100} band={vm.ingredientsBand} note={t("healthyRange")} bandLabel={bandLabel[vm.ingredientsBand]} />
        <HealthRow label={t("staff")} pct={vm.staffRatio * 100} band={vm.staffBand} note={t("healthyRange")} bandLabel={bandLabel[vm.staffBand]} />
        <HealthRow label={t("ingredientsPlusStaff")} pct={vm.combinedRatio * 100} band={vm.combinedBand} note={t("keepUnder")} bandLabel={bandLabel[vm.combinedBand]} />
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-[17px] font-bold">{t("vsLastPeriod")}</h2>
        {vm.changes.map((change) => {
          const good = change.lowerIsBetter ? change.deltaCents <= 0 : change.deltaCents >= 0;
          return (
            <div key={change.key} className="flex items-center gap-2.5 text-[15px]">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl ${good ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>
                {change.deltaCents >= 0 ? <TrendingUp size={16} aria-hidden="true" /> : <TrendingDown size={16} aria-hidden="true" />}
              </span>
              <span className="flex-1">{changeLabels[change.key] ?? change.label}</span>
              <b className={good ? "text-good" : "text-warn"}>
                {change.deltaCents >= 0 ? "+" : "−"}
                <Money cents={Math.abs(change.deltaCents)} />
              </b>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function RowGroup({ label, pct, color, children }: { label: string; pct: number; color: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 py-3.5 pb-1.5">
        <span className={`h-3 w-3 rounded-[3px] ${color}`} />
        <span className="flex-1 text-[13px] font-extrabold tracking-wide text-ink-muted">{label.toUpperCase()}</span>
        <span className="text-[13px] font-bold text-ink-muted">{pct}%</span>
      </div>
      {children}
    </div>
  );
}

function Row({
  name,
  cents,
  estimate,
  estimateLabel,
  addLabel,
  last,
}: {
  name: string;
  cents: number | null;
  estimate?: boolean;
  estimateLabel?: string;
  addLabel?: string;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 py-2 ${last ? "border-b border-[#EFE7DB] pb-3" : ""}`}>
      <span className={`flex-1 text-[15px] ${cents === null ? "font-semibold text-warn" : ""}`}>{name}</span>
      {estimate && <EstimatePill label={estimateLabel ?? "Estimate"} />}
      {cents === null ? (
        <Link href="/add-cost" className="flex h-[34px] items-center rounded-2xl bg-warn px-3 text-[13px] font-bold text-white">
          {addLabel ?? "Add"}
        </Link>
      ) : (
        <span className="text-base font-bold">
          <Money cents={cents} />
        </span>
      )}
    </div>
  );
}
