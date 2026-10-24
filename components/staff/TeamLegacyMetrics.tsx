import {getTranslations,getLocale} from "next-intl/server";
import {isSupabaseConfigured} from "@/lib/supabase/client";
import {getSnapshot} from "@/lib/data/getSnapshot";
import {getEmployees} from "@/lib/data/getEmployees";
import {Link} from "@/i18n/navigation";
import {buildStaffViewModel} from "@/lib/viewmodels/staffViewModel";
import {getPayrollCostSettings} from "@/lib/data/getPayrollCostSettings";
import {getTeamRules} from "@/lib/actions/teamRules";
import {minutesToParts} from "@/lib/calc/scheduling/ruleInputValues";
import {formatInTimeZone} from "date-fns-tz";
import Money from "@/components/shared/Money";
import StaffCostBars,{shortWeekday} from "@/components/staff/StaffCostBars";

/** Retain the legacy, actual-timecard analytics below the scheduling workspace.
 * Scheduled wages above are not mixed into the historical actuals here. */
export default async function TeamLegacyMetrics(){
 if(!isSupabaseConfigured())return null;
 const [snapshot,payroll,t,locale,team,rules,tRules]=await Promise.all([
  getSnapshot(),getPayrollCostSettings(),getTranslations("Staff"),getLocale(),getEmployees(),getTeamRules(),getTranslations("StaffSchedule")
 ]);
 const vm=buildStaffViewModel(snapshot,team);
 const clock=(iso:string)=>new Intl.DateTimeFormat(locale,{timeZone:snapshot.business.timezone,hour:"numeric",minute:"2-digit"}).format(new Date(iso));
 return <section className="mt-6 space-y-3" aria-label={t("onShiftNow")}>
  <section className="rounded-card-lg bg-card p-4">
   <h2 className="text-lg font-bold">{vm.onShift.length?t("activeShiftHero",{count:vm.onShift.length}):t("noOneOnShiftHero")}</h2>
   <p className="mt-1 text-sm text-ink-muted">{vm.onShift.length?vm.onShift.map(s=>s.name).join(", "):t("noOneOnShift")}</p>
   {vm.hasUnmatchedTimecards && <Link href="/more/uploads#upload-history" className="mt-2 inline-flex min-h-12 items-center text-sm font-semibold text-accent-text underline">{t("matchNames")}</Link>}
   <p className="mt-3 text-sm">{t("staffCostToday")} <strong><Money cents={vm.costTodayCents}/></strong></p>
   {vm.onShift.map(s=><p key={s.employeeId} className="mt-2 flex justify-between gap-2 border-t border-line pt-2 text-sm">
    <span>{s.name} · {clock(s.clockInIso)}</span><strong><Money cents={s.todayCostCents}/></strong>
   </p>)}
  </section>
  {rules.ok&&<section className="rounded-card-lg bg-card p-4">
   <h2 className="text-lg font-bold">{tRules("rulesAndCosts")}</h2>
   <p className="mt-2 text-ink-muted">{tRules("rulesSummary",{
    mealHours:new Intl.NumberFormat(locale).format(minutesToParts(Number(rules.data.meal_break_after_minutes)).hours),
    mealMinutes:new Intl.NumberFormat(locale).format(minutesToParts(Number(rules.data.meal_break_after_minutes)).minutes),
    otHours:new Intl.NumberFormat(locale).format(minutesToParts(Number(rules.data.weekly_ot_after_minutes)).hours),
    otMinutes:new Intl.NumberFormat(locale).format(minutesToParts(Number(rules.data.weekly_ot_after_minutes)).minutes)
   })}</p>
   <Link href="/staff/rules" className="mt-2 inline-flex min-h-12 items-center font-semibold text-accent-text underline">{t("payrollCostsEdit")}</Link>
  </section>}
  <section className="rounded-card-lg bg-card p-4">
   <h2 className="text-lg font-bold">{t("payrollCostsTitle")}</h2>
   <p className="mt-2 text-ink-muted">{t("payrollCostsSummary",{percent:new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(payroll.employerCostRate*100)})}</p>
   <Link href="/staff/rules" className="mt-2 inline-flex min-h-12 items-center font-semibold text-accent-text underline">{t("payrollCostsEdit")}</Link>
  </section>
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
