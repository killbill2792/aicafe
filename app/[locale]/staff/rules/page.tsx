import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getTeamRules} from "@/lib/actions/teamRules";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import RulesWorkspace from "@/components/staff/RulesWorkspace";
import PageShell from "@/components/shared/PageShell";
export const dynamic="force-dynamic";
export default async function RulesPage(){
 await requireOwnBusiness();
 const [result,scope,t]=await Promise.all([getTeamRules(),staffReadScope(),getTranslations("StaffSchedule")]);
 const week=mondayOfLocalDate(scope.ok?scope.today:new Date().toISOString().slice(0,10));
 return <PageShell className="px-4 py-6">{result.ok?
  <RulesWorkspace key={JSON.stringify(result.data)} initial={result.data} week={week} readOnly={result.readOnly}/>:
  <p role="alert">{t("loadError")} ({result.error})</p>}</PageShell>;
}
