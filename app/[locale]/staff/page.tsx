import {formatInTimeZone} from "date-fns-tz";
import {getCafeProfile} from "@/lib/data/getCafeProfile";
import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getWeekSchedule} from "@/lib/actions/schedule";
import StaffWorkspace from "@/components/staff/StaffWorkspace";
import PosImportReviewPanel from "@/components/staff/PosImportReviewPanel";
import OwnerScheduleSendPanel from "@/components/staff/OwnerScheduleSendPanel";
import PageShell from "@/components/shared/PageShell";
import TeamLegacyMetrics from "@/components/staff/TeamLegacyMetrics";
import {createStaffScreenshotFixture} from "@/lib/calc/scheduling/staffScreenshotFixture";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {scheduleWeekForDate,validScheduleDate} from "@/lib/scheduling/staffScheduleLinks";
import {validShiftClock} from "@/lib/calc/scheduling/shiftInput";
import {isStaffRuleKey} from "@/lib/calc/scheduling/ruleFixPreview";
import {syncStaffRuleAlerts} from "@/lib/scheduling/ruleAlerts.server";
export const dynamic="force-dynamic";
export default async function StaffPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{tab?:string;week?:string;date?:string;employee?:string;fix?:string;clock?:string;fixture?:string;sendFixture?:string}>}){
 await requireOwnBusiness();
 const [{locale},{tab,week,date,employee,fix,clock,fixture,sendFixture}]=await Promise.all([params,searchParams]);
 const [scope,t]=await Promise.all([staffReadScope(),getTranslations("StaffSchedule")]);
 const selected=scheduleWeekForDate(date,week,mondayOfLocalDate(scope.ok?scope.today:formatInTimeZone(new Date(),(await getCafeProfile()).timezone,"yyyy-MM-dd")));
 const useFixture=process.env.NODE_ENV==="development"&&process.env.STAFF_VISUAL_FIXTURES==="true"&&fixture==="1";
 const showSendFixture=useFixture&&sendFixture==="1";
 const [result,alerts]=useFixture
  ? ([{ok:true as const,data:createStaffScreenshotFixture(selected)},{ok:true as const,alerts:[]}] as const)
  : await Promise.all([getWeekSchedule({weekStart:selected}),syncStaffRuleAlerts()]);
 return <PageShell className="!max-w-full">{result.ok?<>
  <PosImportReviewPanel people={result.data.team.map(person=>({id:person.id,name:person.name}))}/>
  <StaffWorkspace key={`${selected}:${date??""}:${employee??""}:${tab??""}:${fix??""}:${clock??""}`} initial={result.data} tab={tab} locale={locale}
   focusDate={validScheduleDate(date)?date:undefined} focusEmployee={employee}
   focusContact={fix==="phone"||fix==="consent"?fix:undefined} focusRule={isStaffRuleKey(fix)?fix:undefined} focusClock={validShiftClock(clock??"")?clock:undefined} teamExtras={<TeamLegacyMetrics/>}
   initialAlerts={alerts.ok?[...alerts.alerts]:[]} alertError={alerts.ok?null:alerts.error}/>
  {showSendFixture&&<OwnerScheduleSendPanel week={selected} locale={locale==="ar"?"ar":locale==="es"?"es":"en"}/>}
  </>:
  <div className="p-6 text-fg"><h1>{t("schedule")}</h1><p role="alert">{t("loadError")} ({result.error}).</p></div>}</PageShell>;
}
