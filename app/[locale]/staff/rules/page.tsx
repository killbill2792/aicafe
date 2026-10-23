import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getTeamRules} from "@/lib/actions/teamRules";
import {staffReadScope,mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import RulesWorkspace from "@/components/staff/RulesWorkspace";
import PageShell from "@/components/shared/PageShell";
export const dynamic="force-dynamic";
export default async function RulesPage(){
 await requireOwnBusiness();
 const [result,scope]=await Promise.all([getTeamRules(),staffReadScope()]);
 const week=mondayOfLocalDate(scope.ok?scope.today:new Date().toISOString().slice(0,10));
 return <PageShell className="px-4 py-6">{result.ok?
  <RulesWorkspace initial={result.data} week={week} readOnly={result.readOnly}/>:
  <p role="alert">Rules unavailable ({result.error})</p>}</PageShell>;
}
