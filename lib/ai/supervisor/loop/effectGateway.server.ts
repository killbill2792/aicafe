import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {OwnerLoopScope,LoopProposal,LoopEffectAttemptSummary} from "./engine";
import {goalCapabilityId,goalMandatePolicy} from "./goal.server";
import {gmailCapabilityId,gmailEffectSchema} from "./gmail.server";
import {reconcileGmailReceipt} from "@/lib/connectors/gmail/provider.server";
type ProposalRow={id:string;business_id:string;owner_user_id:string;thread_id:string;
 capability_id:string;capability_version:number;canonical_effect_payload:unknown;effect_hash:string;
 baseline:Record<string,unknown>;monitor_spec:{durationDays:number;metricScope:string};
 status:LoopProposal["status"];revision:number;locale:LoopProposal["locale"];
 monitoring_start_date:string|null;created_at:string};
export type EffectAuthorizationKind="click"|"mandate";
export type EffectClaim={proposal:LoopProposal;attemptKey:string;businessDate:string;
 authorizationKind:EffectAuthorizationKind};
export type SupervisorMandate={id:string;revision:number;business_id:string;owner_user_id:string;
 capability_id:typeof goalCapabilityId;capability_version:1;policy_hash:string;limit_kind:"count";
 limit_value:typeof goalMandatePolicy.limitValue;currency:null;period_kind:"cafe_day";expires_at:string;
 revoked_at:string|null;superseded_at:string|null;verified_at:string;created_at:string};
export type MandateChallenge={id:string;business_id:string;owner_user_id:string;
 action:"grant"|"revise";mandate_id:string;mandate_revision:number;
 capability_id:"leo.goal.v1";capability_version:1;policy_hash:string;limit_value:typeof goalMandatePolicy.limitValue;
 period_kind:"cafe_day";mandate_expires_at:string;factor_id:string;
 provider_challenge_id:string;expires_at:string;consumed_at:string|null;created_at:string};
const decode=(r:ProposalRow):LoopProposal=>({id:r.id,businessId:r.business_id,
 ownerUserId:r.owner_user_id,threadId:r.thread_id,capabilityId:r.capability_id,
 capabilityVersion:r.capability_version,canonicalEffectPayload:r.canonical_effect_payload,
 effectHash:r.effect_hash,baseline:r.baseline,monitorSpec:r.monitor_spec,status:r.status,
 revision:r.revision,locale:r.locale,monitoringStartDate:r.monitoring_start_date,createdAt:r.created_at});
const fail=(error:unknown,message:string):never=>{throw new Error(message,{cause:error});};
/** The sole server-side authority for reserving, finishing and auditing effects. */
export class SupervisorEffectGateway{
 async claim(scope:OwnerLoopScope,id:string,revision:number,authorizationKind:EffectAuthorizationKind):Promise<EffectClaim>{
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_claim_effect",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_revision:revision,p_authorization_kind:authorizationKind});
  if(error||!data)fail(error,"Effect authorization failed");
  const row=data as {proposal:ProposalRow;attempt_key:string;business_date:string;authorization_kind:EffectAuthorizationKind};
  if(!row.proposal||row.proposal.id!==id||row.proposal.business_id!==scope.businessId||
   row.proposal.owner_user_id!==scope.ownerUserId||row.proposal.thread_id!==scope.threadId||
   row.proposal.status!=="executing"||!row.attempt_key||row.authorization_kind!==authorizationKind||
   !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date))throw new Error("Effect gateway returned an invalid scoped claim");
  return {proposal:decode(row.proposal),attemptKey:row.attempt_key,businessDate:row.business_date,authorizationKind};
 }
 async finish(scope:OwnerLoopScope,claim:EffectClaim,expectedRevision:number,state:"verified"|"uncertain"|"stale",
  nextStatus?:"committed"|"manual_pending",monitoringStartDate?:string):Promise<LoopProposal>{
  const functionName=claim.proposal.capabilityId===gmailCapabilityId?
   "supervisor_finish_gmail_effect_attempt":"supervisor_finish_effect_attempt";
  const {data,error}=await createAdminSupabaseClient().rpc(functionName,{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:claim.proposal.id,p_attempt_key:claim.attemptKey,p_revision:expectedRevision,
   p_state:state,p_next_status:state==="verified"?nextStatus:null,
   p_monitoring_start_date:state==="verified"?monitoringStartDate??null:null});
  if(error||!data)fail(error,"Effect attempt completion failed");
  const proposal=decode(data as ProposalRow);
  if(proposal.id!==claim.proposal.id||proposal.businessId!==scope.businessId||
   proposal.ownerUserId!==scope.ownerUserId||proposal.threadId!==scope.threadId||
   (state==="verified"&&proposal.status!==nextStatus)||(state==="uncertain"&&proposal.status!=="executing")||
   (state==="stale"&&proposal.status!=="stale"))
   throw new Error("Effect gateway completion returned an invalid proposal");
  return proposal;
 }
 /** Authoritative recovery: the database must prove a scoped postcondition.
  * This RPC never invokes a capability commit or a provider send. */
 async reconcile(scope:OwnerLoopScope,id:string,revision:number):Promise<LoopProposal>{
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_reconcile_effect_attempt",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_revision:revision});
  if(error||!data)fail(error,"Effect outcome reconciliation failed");
  const proposal=decode(data as ProposalRow);
  if(proposal.id!==id||proposal.businessId!==scope.businessId||
   proposal.ownerUserId!==scope.ownerUserId||proposal.threadId!==scope.threadId||
   !["executing","committed","manual_pending"].includes(proposal.status))
   throw new Error("Effect reconciliation returned an invalid scoped proposal");
  return proposal;
 }
 async reconcileGmail(scope:OwnerLoopScope,id:string,revision:number):Promise<LoopProposal>{
  const db=createAdminSupabaseClient();
  const {data:row,error:readError}=await db.from("supervisor_proposals").select("*")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("thread_id",scope.threadId).eq("id",id).maybeSingle();
  if(readError||!row||row.id!==id||row.business_id!==scope.businessId||
     row.owner_user_id!==scope.ownerUserId||row.thread_id!==scope.threadId||
     row.revision!==revision||row.capability_id!==gmailCapabilityId||
     row.status!=="executing")throw new Error("Gmail reconciliation scope unavailable");
  const effect=gmailEffectSchema.parse(row.canonical_effect_payload);
  const verified=await reconcileGmailReceipt({businessId:scope.businessId,ownerUserId:scope.ownerUserId},
    effect,id,row.effect_hash).catch(()=>false);
  if(!verified)return decode(row as ProposalRow);
  const {data:attempt,error:attemptError}=await db.from("supervisor_effect_attempts")
    .select("attempt_key,business_date,state").eq("business_id",scope.businessId).eq("proposal_id",id)
    .eq("effect_hash",row.effect_hash).maybeSingle();
  if(attemptError||!attempt||!["executing","uncertain"].includes(attempt.state))
    throw new Error("Gmail attempt unavailable");
  const {data:finalized,error}=await db.rpc("supervisor_finish_gmail_effect_attempt",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
    p_proposal_id:id,p_attempt_key:attempt.attempt_key,p_revision:revision,
    p_state:"verified",p_next_status:"committed",p_monitoring_start_date:attempt.business_date
  });
  if(error||!finalized)throw new Error("Gmail receipt completion failed");
  const verifiedProposal=decode(finalized as ProposalRow);
  if(verifiedProposal.businessId!==scope.businessId||verifiedProposal.ownerUserId!==scope.ownerUserId||
     verifiedProposal.threadId!==scope.threadId||verifiedProposal.id!==id||
     verifiedProposal.status!=="committed")
    throw new Error("Gmail reconciliation returned an invalid scoped proposal");
  return verifiedProposal;
 }
  async readAttempt(scope:OwnerLoopScope,id:string):Promise<LoopEffectAttemptSummary|null>{
  const db=createAdminSupabaseClient();
  // The attempt ledger has no owner_user_id or thread_id columns. Authorize
  // against the immutable, owner-scoped proposal before reading its attempt.
  const {data:proposal,error:proposalError}=await db.from("supervisor_proposals")
   .select("id,effect_hash").eq("business_id",scope.businessId)
   .eq("owner_user_id",scope.ownerUserId).eq("thread_id",scope.threadId)
   .eq("id",id).maybeSingle();
  if(proposalError)fail(proposalError,"Effect proposal scope unavailable");
  if(!proposal)return null;
  const {data,error}=await db.from("supervisor_effect_attempts")
   .select("state,authorization_kind,business_date").eq("business_id",scope.businessId)
   .eq("proposal_id",id).eq("effect_hash",proposal.effect_hash)
   .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)fail(error,"Effect attempt status unavailable");
  if(!data)return null;
  const row=data as {state:string;authorization_kind:string;business_date:string};
  if(!["executing","verified","uncertain","stale"].includes(row.state)||
   !["click","mandate"].includes(row.authorization_kind)||
   !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date))
   throw new Error("Invalid effect attempt status");
  return {state:row.state as LoopEffectAttemptSummary["state"],
   authorizationKind:row.authorization_kind as EffectAuthorizationKind,businessDate:row.business_date};
 }
 async commitStaff(scope:OwnerLoopScope,id:string,revision:number):
  Promise<{state:"applied"|"stale";proposal:LoopProposal;attemptKey:string}>{
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_gateway_commit_staff",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_revision:revision});
  if(error||!data)fail(error,"Staff effect gateway transaction failed");
  const result=data as {state:string;proposal:ProposalRow;attempt_key:string};
  if((result.state!=="applied"&&result.state!=="stale")||!result.proposal||!result.attempt_key)
   throw new Error("Invalid staff effect gateway receipt");
  const proposal=decode(result.proposal);
  if(proposal.id!==id||proposal.businessId!==scope.businessId||proposal.ownerUserId!==scope.ownerUserId||
   proposal.threadId!==scope.threadId||proposal.status!==(result.state==="applied"?"committed":"stale"))
   throw new Error("Staff effect gateway result outside scope");
  return {state:result.state,proposal,attemptKey:result.attempt_key};
 }
 async createMandateChallenge(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId">,
  input:{id:string;action:"grant"|"revise";mandateId:string;mandateRevision:number;
   policyHash:string;limitValue:typeof goalMandatePolicy.limitValue;mandateExpiresAt:string;factorId:string;
   providerChallengeId:string;challengeExpiresAt:string}):Promise<MandateChallenge>{
  if(input.limitValue!==goalMandatePolicy.limitValue)throw new Error("mandate_limit_must_be_5_per_cafe_day");
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_create_mandate_challenge",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_challenge_id:input.id,
   p_action:input.action,p_mandate_id:input.mandateId,p_mandate_revision:input.mandateRevision,
   p_capability_id:goalCapabilityId,p_capability_version:1,p_policy_hash:input.policyHash,
   p_limit_value:input.limitValue,p_period_kind:"cafe_day",p_mandate_expires_at:input.mandateExpiresAt,
   p_factor_id:input.factorId,p_provider_challenge_id:input.providerChallengeId,
   p_challenge_expires_at:input.challengeExpiresAt});
  if(error||!data)fail(error,"Mandate challenge could not be saved");
  const row=data as MandateChallenge;
  if(row.id!==input.id||row.business_id!==scope.businessId||row.owner_user_id!==scope.ownerUserId||
   row.factor_id!==input.factorId||row.provider_challenge_id!==input.providerChallengeId||row.consumed_at!==null)
   throw new Error("Mandate challenge persistence returned an invalid binding");
  return row;
 }
 async loadMandateChallenge(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId">,id:string):Promise<MandateChallenge>{
  const {data,error}=await createAdminSupabaseClient().from("supervisor_mandate_challenges").select("*")
   .eq("id",id).eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId).maybeSingle();
  if(error||!data)fail(error,"Mandate challenge not available");
  const row=data as MandateChallenge;
  if(row.consumed_at||Date.parse(row.expires_at)<=Date.now())throw new Error("Mandate challenge expired or consumed");
  return row;
 }
 async completeMandateChallenge(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId">,
  challenge:MandateChallenge):Promise<SupervisorMandate>{
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_complete_mandate_challenge",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_challenge_id:challenge.id,
   p_factor_id:challenge.factor_id,p_provider_challenge_id:challenge.provider_challenge_id});
  if(error||!data)fail(error,"Verified mandate could not be saved");
  const row=data as SupervisorMandate;
  if(row.business_id!==scope.businessId||row.owner_user_id!==scope.ownerUserId||
   row.id!==challenge.mandate_id||row.capability_id!==goalCapabilityId||
   row.limit_value!==challenge.limit_value||row.policy_hash!==challenge.policy_hash||
   row.period_kind!=="cafe_day"||row.revoked_at!==null||row.superseded_at!==null)
   throw new Error("Mandate completion returned an invalid policy");
  return row;
 }
 async listMandates(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId">):Promise<SupervisorMandate[]>{
  const {data,error}=await createAdminSupabaseClient().from("supervisor_mandates").select("*")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .is("superseded_at",null).order("revision",{ascending:false});
  if(error)fail(error,"Mandates unavailable");
  return (data??[]) as SupervisorMandate[];
 }
 async revokeMandate(scope:Pick<OwnerLoopScope,"businessId"|"ownerUserId">,id:string,revision:number):Promise<SupervisorMandate>{
  const {data,error}=await createAdminSupabaseClient().rpc("supervisor_revoke_mandate",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_mandate_id:id,p_revision:revision});
  if(error||!data)fail(error,"Mandate revocation failed");
  const row=data as SupervisorMandate;
  if(row.id!==id||row.business_id!==scope.businessId||row.owner_user_id!==scope.ownerUserId||!row.revoked_at)
   throw new Error("Mandate revocation returned an invalid row");
  return row;
 }
}
