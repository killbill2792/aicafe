import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getWeekSchedule} from "@/lib/actions/schedule";
import StaffWorkspace from "@/components/staff/StaffWorkspace";
import PageShell from "@/components/shared/PageShell";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {syncStaffRuleAlerts} from "@/lib/scheduling/ruleAlerts.server";
export const dynamic="force-dynamic";
export default async function StaffPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{tab?:string;week?:string}>}){
 await requireOwnBusiness();
 const [{locale},{tab,week}]=await Promise.all([params,searchParams]);
 const scope=await staffReadScope();
 const selected=/^\d{4}-\d{2}-\d{2}$/.test(week??"")?week!:mondayOfLocalDate(scope.ok?scope.today:new Date().toISOString().slice(0,10));
 const [result,alerts]=await Promise.all([getWeekSchedule({weekStart:selected}),syncStaffRuleAlerts()]);
 return <PageShell className="!max-w-full">{result.ok?
  <StaffWorkspace initial={result.data} tab={tab} locale={locale}
   initialAlerts={alerts.ok?alerts.alerts:[]} alertError={alerts.ok?null:alerts.error}/>:
  <div className="p-6 text-fg"><h1>Schedule</h1><p role="alert">Could not load the schedule ({result.error}). Confirm the staff migration is installed.</p></div>}</PageShell>;
}
