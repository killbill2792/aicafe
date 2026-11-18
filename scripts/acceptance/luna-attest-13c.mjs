// Trusted-host scenario attester extracted from .github/workflows/ai-cafe-13c-owner-live.yml (main).
// Candidate source is never imported; host alone reads provider audit and local DB.
import {readFileSync,writeFileSync} from "node:fs";
const dir=process.env.RUNNER_TEMP;
const audit=JSON.parse(readFileSync(dir+"/task13c-host-audit.json","utf8"));
const proof=JSON.parse(readFileSync(dir+"/task13c-candidate-proof/13c-live-proof.json","utf8"));
const scope=JSON.parse(readFileSync(dir+"/task13c-candidate-proof/13c-live-scope.json","utf8"));
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
 "'verifiedDecline',(select count(*) from public.staff_communication_messages "+
   "where business_id="+business+" and id="+uuid("messageId")+
   " and employee_id="+uuid("originalEmployeeId")+
   " and actor='employee' and response_code='decline'),"+
 "'ownerPosts',(select count(*) from public.ai_messages where "+
   "business_id="+business+" and thread_id="+uuid("threadId")+
   " and role='supervisor' and grounding->>'intent'='priority_investigation'),"+
 "'currentAssignee',(select employee_id::text from public.scheduled_shifts "+
   "where business_id="+business+" and id="+uuid("shiftId")+"),"+
 "'taskStatus',(select status from public.operating_tasks "+
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
if(Number(facts.verifiedDecline)!==1||
   Number(facts.ownerPosts)<1||
   facts.currentAssignee!==scope.replacementEmployeeId||
   facts.taskStatus!=="handled"||
   facts.investigationPhase!=="resolved"||
   Number(facts.completedQuota)!==audit.attempts||
   scope.expectedProviderCalls!==audit.attempts||
   Number(facts.foreignOwnerMembership)!==0)
  throw Error("Independent migrated DB/owner/source proof failed");

const tools=audit.receipts.flatMap(r=>
  Array.isArray(r.toolNames)?r.toolNames:[]);
const staffing=tools.includes("get_staff_messages");
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
   proof.negative_no_automatic_roster_effect!==true||
   proof.cross_cafe_owner_denied!==true||
   proof.persisted_followup!==true||
   proof.source_verified_manual_roster_correction!==true||
   proof.actual_supervisor_roster_effect!==false||
   !Number.isSafeInteger(audit.attempts)||audit.attempts<2||
   audit.attempts>18||audit.reservedMicros<1||
   audit.reservedMicros>180_000||receipts.length!==audit.attempts||
   audit.receipts.length!==audit.attempts||
   audit.receipts.some(r=>r.terminal!=="completed"||r.model!=="gpt-6-luna"))
  throw Error("Unverified 13C real Luna provider/source/owner acceptance");
// A candidate cannot forge trusted host model-completion and tool
// receipts: the raw key, audit and attester are outside Docker.
const safe={task:"13C",head:audit.head,provider:"openai_responses",
  model:"gpt-6-luna",attempts:audit.attempts,
  reservedUpperUSD:audit.reservedMicros/1_000_000,
  actualInputTokens:receipts.reduce((n,r)=>n+r.actualInputTokens,0),
  actualOutputTokens:receipts.reduce((n,r)=>n+r.actualOutputTokens,0),
  trustedToolNames:[...new Set(tools)].sort(),
  staffAndRosterCorroborated:true,independentOwnerDatabaseProof:true,
  actualExternalEffectPerformed:false,
  fullIntegratedTask17Proof:false};
writeFileSync(dir+"/task13c-sanitized-result.json",
  JSON.stringify(safe,null,2)+"\n",{mode:0o600,flag:"wx"});
