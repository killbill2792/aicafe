import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getTeamRules} from "@/lib/actions/teamRules";
import RulesWorkspace from "@/components/staff/RulesWorkspace";
import PageShell from "@/components/shared/PageShell";
export const dynamic="force-dynamic";
export default async function RulesPage(){await requireOwnBusiness();const result=await getTeamRules();
 return <PageShell className="px-4 py-6">{result.ok?<RulesWorkspace initial={result.data}/>:
  <p role="alert">Rules unavailable ({result.error})</p>}</PageShell>
}
