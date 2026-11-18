// Trusted-host scenario attester extracted from .github/workflows/ai-cafe-13d-owner-live.yml (test/task13d-owner-gated-live-luna-20261117).
// Candidate source is never imported; host alone reads provider audit and local DB.
import {readFileSync,writeFileSync} from "node:fs";
const dir=process.env.RUNNER_TEMP;
const audit=JSON.parse(readFileSync(dir+"/task13d-host-audit.json","utf8"));
const proof=JSON.parse(readFileSync(dir+"/task13d-candidate-proof/13d-live-proof.json","utf8"));
const scope=JSON.parse(readFileSync(dir+"/task13d-candidate-proof/13d-live-scope.json","utf8"));
if(typeof scope.leaveDate!=="string"||!/^(?:20)\d{2}-\d{2}-\d{2}$/.test(scope.leaveDate))throw Error("Invalid dated leave source");
// Candidate prose and self-reported completion never count as DB
// truth. A host process with NO candidate code imports independently
// queries the local migrated PostgreSQL over its own CLI.
const uuid=(field)=>{
  const value=scope[field];
  if(typeof value!=="string"||
     !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw Error("Invalid private host query scope");
  return "'"+value+"'";
};
if(typeof scope.taskId!=="string"||
   !/^[a-z0-9:_-]{1,220}$/i.test(scope.taskId)||
   !Number.isSafeInteger(scope.expectedProviderCalls))
  throw Error("Invalid durable incident identity");
const task="'"+scope.taskId+"'";
const business=uuid("businessId"),owner=uuid("ownerUserId");
const sql="select json_build_object("+
 "'caseState',(select state from public.staff_coordination_cases "+
   "where business_id="+business+" and id="+uuid("caseId")+"),"+
 "'ownerDecision',(select decision from public.staff_coordination_cases "+
   "where business_id="+business+" and id="+uuid("caseId")+"),"+
 "'approvedSourceRows',(select count(*) from public.staff_availability_exceptions a "+
   "join public.staff_coordination_cases c on c.business_id=a.business_id "+
   "and c.employee_id=a.employee_id where a.business_id="+business+
   " and c.id="+uuid("caseId")+" and a.local_date="+
   "'"+scope.leaveDate.replaceAll("'","")+"'" +
   " and a.exception_type='approved_leave' and a.confirmation='owner_confirmed' "+
   "and a.confirmed_at>=c.decided_at),"+
 "'verifiedCaseEvidence',(select count(*) from public.staff_coordination_evidence "+
   "where business_id="+business+" and case_id="+uuid("caseId")+
   " and evidence_key='verified_leave' and source_kind='availability_exception'),"+
 "'ownerPosts',(select count(*) from public.ai_messages where "+
   "business_id="+business+" and thread_id="+uuid("threadId")+
   " and role='supervisor' and grounding->>'intent'='priority_investigation'),"+
 "'currentAssignee',(select employee_id::text from public.scheduled_shifts "+
   "where business_id="+business+" and id="+uuid("shiftId")+"),"+
 "'taskStatus',(select status from public.operating_tasks "+
   "where business_id="+business+" and id="+task+"),"+
 "'taskEvidenceVerified',(select payload->>'sourceVerified' from public.operating_tasks "+
   "where business_id="+business+" and id="+task+"),"+
 "'investigationPhase',(select phase from public.supervisor_investigations "+
   "where business_id="+business+" and source_id="+task+"),"+
 "'completedQuota',(select count(*) from public.supervisor_system_usage_events "+
   "where business_id="+business+" and owner_user_id="+owner+
   " and model='gpt-6-luna' and status='completed'),"+
 "'foreignOwnerMembership',(select count(*) from public.memberships where "+
   "business_id="+business+" and user_id="+uuid("foreignOwnerUserId")+"))::text;";
const {execFileSync}=await import("node:child_process");
const raw=execFileSync("psql",
  ["-X","-q","-t","-A","-h","127.0.0.1","-p","54322",
   "-U","postgres","-d","postgres","-c",sql],
  {encoding:"utf8",env:{...process.env,PGPASSWORD:"postgres"},
   timeout:15000,maxBuffer:100000}).trim();
const facts=JSON.parse(raw);
if(facts.caseState!=="completed"||facts.ownerDecision!=="approve"||
   Number(facts.approvedSourceRows)!==1||
   Number(facts.verifiedCaseEvidence)!==1||
   Number(facts.ownerPosts)<1||
   facts.currentAssignee!==scope.employeeId||
   facts.taskStatus!=="handled"||facts.taskEvidenceVerified!=="true"||
   facts.investigationPhase!=="resolved"||
   Number(facts.completedQuota)!==audit.attempts||
   scope.expectedProviderCalls!==audit.attempts||
   Number(facts.foreignOwnerMembership)!==0)
  throw Error("Independent migrated DB/owner/source proof failed");

const tools=audit.receipts.flatMap(r=>
  Array.isArray(r.toolNames)?r.toolNames:[]);
const staffing=tools.includes("get_staff_coordination_cases");
const roster=["get_week_schedule","get_schedule","get_coverage_gaps"]
  .some(t=>tools.includes(t));
if(!staffing||!roster||!tools.includes("get_investigation_source"))
  throw Error("Trusted provider did not select required staff/roster source tools");
const receipts=audit.receipts.filter(r=>r.terminal==="completed"&&
  Number.isSafeInteger(r.actualInputTokens)&&r.actualInputTokens>0&&
  Number.isSafeInteger(r.actualOutputTokens)&&r.actualOutputTokens>=0);
if(audit.head!==process.env.HEAD_SHA||
   proof.head_sha!==audit.head||proof.status!=="passed"||
   proof.observed_model!=="gpt-6-luna"||
   proof.negative_no_automatic_leave_effect!==true||
   proof.cross_cafe_owner_denied!==true||
   proof.persisted_followup!==true||
   proof.source_verified_human_applied_leave!==true||
   proof.actual_supervisor_leave_effect!==false||
   !Number.isSafeInteger(audit.attempts)||audit.attempts<2||
   audit.attempts>18||audit.reservedMicros<1||
   audit.reservedMicros>180_000||receipts.length!==audit.attempts||
   audit.receipts.length!==audit.attempts||
   audit.receipts.some(r=>r.terminal!=="completed"||r.model!=="gpt-6-luna"))
  throw Error("Unverified 13D real Luna provider/source/owner acceptance");
// A candidate cannot forge trusted host model-completion and tool
// receipts: the raw key, audit and attester are outside Docker.
const safe={task:"13D",head:audit.head,provider:"openai_responses",
  model:"gpt-6-luna",attempts:audit.attempts,
  reservedUpperUSD:audit.reservedMicros/1_000_000,
  actualInputTokens:receipts.reduce((n,r)=>n+r.actualInputTokens,0),
  actualOutputTokens:receipts.reduce((n,r)=>n+r.actualOutputTokens,0),
  trustedToolNames:[...new Set(tools)].sort(),
  caseAndRosterCorroborated:true,independentOwnerDatabaseProof:true,
  actualExternalEffectPerformed:false,
  fullIntegratedTask17Proof:false};
writeFileSync(dir+"/task13d-sanitized-result.json",
  JSON.stringify(safe,null,2)+"\n",{mode:0o600,flag:"wx"});
