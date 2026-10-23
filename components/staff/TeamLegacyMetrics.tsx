import {getTranslations,getLocale} from "next-intl/server";
import {isSupabaseConfigured} from "@/lib/supabase/client";
import {getSnapshot} from "@/lib/data/getSnapshot";
import {buildStaffViewModel} from "@/lib/viewmodels/staffViewModel";
import {getPayrollCostSettings} from "@/lib/data/getPayrollCostSettings";
import {formatInTimeZone} from "date-fns-tz";
import Money from "@/components/shared/Money";
import PayrollCostCard from "@/components/staff/PayrollCostCard";
import StaffCostBars,{shortWeekday} from "@/components/staff/StaffCostBars";

/** Retain the legacy, actual-timecard analytics below the scheduling workspace.
 * Scheduled wages above are not mixed into the historical actuals here. */
export default async function TeamLegacyMetrics(){
 if(!isSupabaseConfigured())return null;
 const [snapshot,payroll,t,locale]=await Promise.all([
  getSnapshot(),getPayrollCostSettings(),getTranslations("Staff"),getLocale()
 ]);
 const vm=buildStaffViewModel(snapshot);
 const clock=(iso:string)=>formatInTimeZone(iso,snapshot.business.timezone,"H:mm");
 return <section className="mt-6 space-y-3" aria-label={t("onShiftNow")}>
  <section className="rounded-card-lg bg-card p-4">
   <h2 className="text-lg font-bold">{vm.onShift.length?t("activeShiftHero",{count:vm.onShift.length}):t("noOneOnShiftHero")}</h2>
   <p className="mt-1 text-sm text-ink-muted">{vm.onShift.length?vm.onShift.map(s=>s.name).join(", "):t("noOneOnShift")}</p>
   <p className="mt-3 text-sm">{t("staffCostToday")} <strong><Money cents={vm.costTodayCents}/></strong></p>
   {vm.onShift.map(s=><p key={s.employeeId} className="mt-2 flex justify-between border-t border-line pt-2 text-sm">
    <span>{s.name} · {clock(s.clockInIso)}</span><strong><Money cents={s.todayCostCents}/></strong>
   </p>)}
  </section>
  <PayrollCostCard settings={payroll} labels={{
   title:t("payrollCostsTitle"),body:t("payrollCostsBody"),field:t("payrollCostsField"),
   hint:t("payrollCostsHint"),source:t("payrollSource"),
   ownerSource:t("payrollSourceOwner"),estimateSource:t("payrollSourceEstimate"),
   quickbooksSource:t("payrollSourceQuickBooks"),importedSource:t("payrollSourceImported"),
   connectedSource:t("payrollSourceConnected"),actualUsing:t("payrollActualUsing"),
   fallbackNote:t("payrollFallbackNote"),save:t("payrollSave"),
   saving:t("payrollSaving"),saved:t("payrollSaved"),invalid:t("payrollInvalid")
  }}/>
  <section className="rounded-card-lg bg-card p-4">
   <h2 className="text-lg font-bold">{t("costPerSalesDollar")}</h2>
   <p className="text-sm text-ink-muted">{t("healthyLine",{cents:vm.healthyCostPerSalesDollarCents})}</p>
   <StaffCostBars days={vm.dailyCostPerSalesDollarCents}
    healthyCents={vm.healthyCostPerSalesDollarCents} locale={locale} todayLabel={t("today")}/>
   <p className="mt-3 text-sm text-ink-muted">{vm.worstDay?
    t("worstDayInsight",{date:shortWeekday(vm.worstDay.date,locale),cents:Math.round(vm.worstDay.cents)}):
    t("allHealthyInsight")}</p>
  </section>
 </section>;
}
