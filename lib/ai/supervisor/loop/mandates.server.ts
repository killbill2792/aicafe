import "server-only";
import {randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {effectHash,type OwnerLoopScope} from "./engine";
import {SupervisorEffectGateway,type SupervisorMandate} from "./effectGateway.server";
import {goalCapabilityId,goalMandatePolicy} from "./goal.server";
const CAPABILITY_ID=goalCapabilityId;
const CAPABILITY_VERSION=1 as const;
const PERIOD_KIND=goalMandatePolicy.periodKind;
const CHALLENGE_TTL_MS=5*60*1000;
export type MandateScope=Pick<OwnerLoopScope,"businessId"|"ownerUserId">;
export type MandateGrantInput={factorId:string;limitValue:5;expiresAt:string;mandateId?:string;revision?:number};
export type MandateVerifyInput={challengeId:string;code:string};
export function mandatePolicyHash(expiresAt:string):string{
 return effectHash({capabilityId:CAPABILITY_ID,capabilityVersion:CAPABILITY_VERSION,
  limitKind:goalMandatePolicy.limitKind,limitValue:goalMandatePolicy.limitValue,
  currency:null,periodKind:PERIOD_KIND,expiresAt});
}
function validFutureDate(value:string):string{
 const date=new Date(value);
 if(!Number.isFinite(date.valueOf())||date.valueOf()<=Date.now())throw new Error("mandate_expiry_required");
 return date.toISOString();
}
function phoneFactor(factors:unknown,factorId:string){
 const phone=(factors as {phone?:Array<{id:string;status:string}>}|null)?.phone??[];
 const factor=phone.find(item=>item.id===factorId&&item.status==="verified");
 if(!factor)throw new Error("verified_phone_factor_required");
 return factor;
}
export async function createMandateChallenge(scope:MandateScope,client:SupabaseClient,
 input:MandateGrantInput,gateway=new SupervisorEffectGateway()){
 if(input.limitValue!==goalMandatePolicy.limitValue)throw new Error("mandate_limit_must_be_5_per_cafe_day");
 const expiresAt=validFutureDate(input.expiresAt);
 const hasId=Boolean(input.mandateId),hasRevision=Number.isSafeInteger(input.revision)&&Number(input.revision)>0;
 if(hasId!==hasRevision)throw new Error("mandate_revision_required");
 const {data:{user},error:userError}=await client.auth.getUser();
 if(userError||!user||user.id!==scope.ownerUserId)throw new Error("authentication_required");
 const {data:factors,error:factorError}=await client.auth.mfa.listFactors();
 if(factorError)throw new Error("phone_mfa_unavailable");
 const factor=phoneFactor(factors,input.factorId);
 const {data:issued,error:challengeError}=await client.auth.mfa.challenge({factorId:factor.id});
 if(challengeError||!issued?.id)throw new Error("phone_mfa_challenge_failed");
 const id=randomUUID(),mandateId=input.mandateId??randomUUID();
 const challengeExpiresAt=new Date(Date.now()+CHALLENGE_TTL_MS).toISOString();
 const policyHash=mandatePolicyHash(expiresAt);
 const saved=await gateway.createMandateChallenge(scope,{id,action:hasId?"revise":"grant",
  mandateId,mandateRevision:hasId?Number(input.revision):0,policyHash,limitValue:input.limitValue,
  mandateExpiresAt:expiresAt,factorId:factor.id,providerChallengeId:issued.id,
  challengeExpiresAt});
 return {challengeId:saved.id,expiresAt:saved.expires_at,mandateExpiresAt:saved.mandate_expires_at,
  capabilityId:CAPABILITY_ID,limitValue:saved.limit_value,periodKind:saved.period_kind};
}
export async function verifyMandateChallenge(scope:MandateScope,client:SupabaseClient,
 input:MandateVerifyInput,gateway=new SupervisorEffectGateway()):Promise<SupervisorMandate>{
 const challenge=await gateway.loadMandateChallenge(scope,input.challengeId);
 const {data:{user},error:userError}=await client.auth.getUser();
 if(userError||!user||user.id!==scope.ownerUserId)throw new Error("authentication_required");
 const {data:factors,error:factorError}=await client.auth.mfa.listFactors();
 if(factorError)throw new Error("phone_mfa_unavailable");
 phoneFactor(factors,challenge.factor_id);
 // OTP plaintext is forwarded directly to Supabase Auth and is never persisted or logged.
 const {data:verified,error:verifyError}=await client.auth.mfa.verify({
  factorId:challenge.factor_id,challengeId:challenge.provider_challenge_id,code:input.code});
 if(verifyError||verified?.user?.id!==scope.ownerUserId)throw new Error("phone_mfa_verification_failed");
 return gateway.completeMandateChallenge(scope,challenge);
}
export async function revokeMandate(scope:MandateScope,id:string,revision:number,
 gateway=new SupervisorEffectGateway()):Promise<SupervisorMandate>{return gateway.revokeMandate(scope,id,revision);}
export async function readMandates(scope:MandateScope,gateway=new SupervisorEffectGateway()){
 return gateway.listMandates(scope);
}
