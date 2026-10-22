import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getWeekSchedule} from "@/lib/actions/schedule";
import StaffWorkspace from "@/components/staff/StaffWorkspace";
import PageShell from "@/components/shared/PageShell";
export const dynamic="force-dynamic";
export default async function StaffPage({params,searchParams}:{params:Promise<{locale:string}>;searchParams:Promise<{tab?:string;week?:string}>}){
 await requireOwnBusiness();
 const [{locale},{tab,week}]=await Promise.all([params,searchParams]);
 const now=new Date(),day=now.getUTCDay();now.setUTCDate(now.getUTCDate()-(day+6)%7);
 const selected=/^\d{4}-\d{2}-\d{2}$/.test(week??"")?week!:now.toISOString().slice(0,10);
 const result=await getWeekSchedule({weekStart:selected});
 return <PageShell className="!max-w-full">{result.ok?
  <StaffWorkspace initial={result.data} tab={tab} locale={locale}/>:
  <div className="p-6 text-fg"><h1>Schedule</h1><p role="alert">Couldn't load the schedule ({result.error}). Confirm the staff migration is installed.</p></div>}</PageShell>;
}