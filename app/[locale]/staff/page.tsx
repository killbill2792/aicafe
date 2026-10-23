import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getWeekSchedule} from "@/lib/actions/schedule";
import StaffWorkspace from "@/components/staff/StaffWorkspace";
import PageShell from "@/components/shared/PageShell";
import TeamLegacyMetrics from "@/components/staff/TeamLegacyMetrics";
import {createStaffScreenshotFixture} from "@/lib/calc/scheduling/staffScreenshotFixture";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {syncStaffRuleAlerts} from "@/lib/scheduling/ruleAlerts.server";
export const dynamic="force-dynamic";
export default async function StaffPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{tab?:string;week?:string;fixture?:string}>}){
 await requireOwnBusiness();
 const [{locale},{tab,week,fixture}]=await Promise.all([params,searchParams]);
 const [scope,t]=await Promise.all([staffReadScope(),getTranslations("StaffSchedule")]);
 const selected=/^\d{4}-\d{2}-\d{2}$/.test(week??"")?week!:mondayOfLocalDate(scope.ok?scope.today:new Date().toISOString().slice(0,10));
 const useFixture=process.env.NODE_ENV==="development"&&process.env.STAFF_VISUAL_FIXTURES==="true"&&fixture==="1";
 const [result,alerts]=useFixture
  ? ([{ok:true as const,data:createStaffScreenshotFixture(selected)},{ok:true as const,alerts:[]}] as const)
  : await Promise.all([getWeekSchedule({weekStart:selected}),syncStaffRuleAlerts()]);
 return <PageShell className="!max-w-full">{result.ok?
  <StaffWorkspace initial={result.data} tab={tab} locale={locale} teamExtras={<TeamLegacyMetrics/>}
   initialAlerts={alerts.ok?alerts.alerts:[]} alertError={alerts.ok?null:alerts.error}/>:
  <div className="p-6 text-fg"><h1>{t("schedule")}</h1><p role="alert">{t("loadError")} ({result.error}).</p></div>}</PageShell>;
}
