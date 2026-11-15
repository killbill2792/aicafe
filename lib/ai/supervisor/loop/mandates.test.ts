import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./goal.server",()=>({goalCapabilityId:"leo.goal.v1",
 goalMandatePolicy:{limitKind:"count",limitValue:5,periodKind:"cafe_day"}}));
import {createMandateChallenge,createStaffScheduleMandateChallenge,
  staffScheduleMandatePolicyHash,mandatePolicyHash,verifyMandateChallenge} from "./mandates.server";
import {goalMandatePolicy} from "./goal.server";
const owner="22222222-2222-4222-8222-222222222222";
const scope={businessId:"11111111-1111-4111-8111-111111111111",ownerUserId:owner};
const challenge={id:"33333333-3333-4333-8333-333333333333",business_id:scope.businessId,
 owner_user_id:owner,action:"grant" as const,mandate_id:"44444444-4444-4444-8444-444444444444",
 mandate_revision:0,capability_id:"leo.goal.v1" as const,capability_version:1 as const,
 policy_hash:"a".repeat(64),limit_value:5,period_kind:"cafe_day" as const,
 mandate_expires_at:"2026-12-01T00:00:00.000Z",factor_id:"55555555-5555-4555-8555-555555555555",
 provider_challenge_id:"provider-challenge",expires_at:"2026-11-11T23:00:00.000Z",
 consumed_at:null,created_at:"2026-11-11T22:00:00.000Z"};
type TestClient={auth:{
 getUser:ReturnType<typeof vi.fn>;
 mfa:{listFactors:ReturnType<typeof vi.fn>;challenge:ReturnType<typeof vi.fn>;verify:ReturnType<typeof vi.fn>};
}};
const makeClient=()=>({auth:{
 getUser:vi.fn(async()=>({data:{user:{id:owner}},error:null})),
 mfa:{
  listFactors:vi.fn(async()=>({data:{phone:[{id:challenge.factor_id,status:"verified"}]},error:null})),
  challenge:vi.fn(async()=>({data:{id:challenge.provider_challenge_id},error:null})),
  verify:vi.fn(async()=>({data:{user:{id:owner}},error:null})),
 },
}} as unknown as TestClient);
const gateway=()=>({
 createMandateChallenge:vi.fn(async(_scope:unknown,input:Record<string,unknown>)=>({...challenge,
  id:input.id,mandate_id:input.mandateId,policy_hash:input.policyHash,
  limit_value:input.limitValue,mandate_expires_at:input.mandateExpiresAt,
  factor_id:input.factorId,provider_challenge_id:input.providerChallengeId,
  expires_at:input.challengeExpiresAt})),
 loadMandateChallenge:vi.fn(async()=>challenge),
 completeMandateChallenge:vi.fn(async()=>({id:challenge.mandate_id,revision:1,
  business_id:scope.businessId,owner_user_id:owner,capability_id:"leo.goal.v1",
  capability_version:1,policy_hash:challenge.policy_hash,limit_kind:"count",limit_value:5,
  currency:null,period_kind:"cafe_day",expires_at:challenge.mandate_expires_at,
  revoked_at:null,superseded_at:null,verified_at:"2026-11-11T22:00:00.000Z",
  created_at:"2026-11-11T22:00:00.000Z"})),
});
beforeEach(()=>vi.clearAllMocks());
describe("phone-MFA-bound staff schedule standing mandates",()=>{
 const week="2026-11-23",expiresAt="2026-11-28T12:00:00.000Z";
 it("binds the exact future Monday and recipient ceiling to existing owner phone-MFA",async()=>{
  const client=makeClient(),g=gateway();
  const staffChallenge={...challenge,capability_id:"olivia.staff_propose_send_schedule.v2",
    capability_version:2,staff_week_start:week,limit_value:2,period_kind:"staff_week"};
  const create=vi.fn(async(_scope:unknown,input:Record<string,unknown>)=>({
    ...staffChallenge,id:input.id,policy_hash:input.policyHash,
    mandate_id:input.mandateId,mandate_expires_at:input.mandateExpiresAt,
    factor_id:input.factorId,provider_challenge_id:input.providerChallengeId,
    expires_at:input.challengeExpiresAt,
  }));
  const result=await createStaffScheduleMandateChallenge(scope,client as never,{
    factorId:challenge.factor_id,limitValue:2,weekStart:week,expiresAt,
  },{...g,createStaffMandateChallenge:create} as never);
  expect(result).toMatchObject({capabilityId:"olivia.staff_propose_send_schedule.v2",
    weekStart:week,limitValue:2,periodKind:"staff_week"});
  expect(client.auth.mfa.challenge).toHaveBeenCalledWith({factorId:challenge.factor_id});
  expect(create).toHaveBeenCalledWith(scope,expect.objectContaining({
    weekStart:week,limitValue:2,action:"grant",mandateRevision:0,
    policyHash:staffScheduleMandatePolicyHash({weekStart:week,limitValue:2,expiresAt}),
  }));
 });
 it("refuses wrong weekday, over-ceiling, expired policy, and unverified phone BEFORE provider challenge",async()=>{
  const client=makeClient(),g=gateway();
  const opts={factorId:challenge.factor_id,limitValue:2,weekStart:week,expiresAt};
  await expect(createStaffScheduleMandateChallenge(scope,client as never,
   {...opts,weekStart:"2026-11-24"},g as never)).rejects.toThrow("staff_mandate_monday_required");
  await expect(createStaffScheduleMandateChallenge(scope,client as never,
   {...opts,limitValue:31},g as never)).rejects.toThrow("staff_mandate_recipient_limit_invalid");
  await expect(createStaffScheduleMandateChallenge(scope,client as never,
   {...opts,expiresAt:"2026-12-02T00:00:00Z"},g as never))
   .rejects.toThrow("staff_mandate_expires_after_week");
  expect(client.auth.mfa.challenge).not.toHaveBeenCalled();
  client.auth.mfa.listFactors.mockResolvedValue({data:{phone:[]},error:null} as never);
  await expect(createStaffScheduleMandateChallenge(scope,client as never,opts,g as never))
   .rejects.toThrow("verified_phone_factor_required");
  expect(client.auth.mfa.challenge).not.toHaveBeenCalled();
 });
 it("uses only the provider's successful OTP verification to persist staff authority",async()=>{
  const client=makeClient(),g=gateway();
  const staffChallenge={...challenge,capability_id:"olivia.staff_propose_send_schedule.v2",
    capability_version:2,staff_week_start:week,limit_value:2,period_kind:"staff_week"};
  g.loadMandateChallenge.mockResolvedValue(staffChallenge as never);
  client.auth.mfa.verify.mockRejectedValueOnce(new Error("wrong code"));
  await expect(verifyMandateChallenge(scope,client as never,{
   challengeId:challenge.id,code:"000000",
  },g as never)).rejects.toThrow();
  expect(g.completeMandateChallenge).not.toHaveBeenCalled();
  await verifyMandateChallenge(scope,client as never,{
   challengeId:challenge.id,code:"123456",
  },g as never);
  expect(client.auth.mfa.verify).toHaveBeenCalledWith({
    factorId:challenge.factor_id,challengeId:challenge.provider_challenge_id,code:"123456",
  });
  expect(g.completeMandateChallenge).toHaveBeenCalledOnce();
 });
 it("policy changes to week, recipient cap or expiry change its cryptographic hash",()=>{
  const digest=staffScheduleMandatePolicyHash({weekStart:week,limitValue:2,expiresAt});
  expect(staffScheduleMandatePolicyHash({weekStart:week,limitValue:3,expiresAt})).not.toBe(digest);
  expect(staffScheduleMandatePolicyHash({weekStart:"2026-11-30",limitValue:2,expiresAt})).not.toBe(digest);
  expect(staffScheduleMandatePolicyHash({weekStart:week,limitValue:2,expiresAt:"2026-11-29T00:00:00Z"}))
    .not.toBe(digest);
 });
});
describe("phone-MFA-bound goal mandates",()=>{
 it("binds the Auth challenge to owner, café, capability, exact cap and expiry",async()=>{
  const client=makeClient(),g=gateway();
  const result=await createMandateChallenge(scope,client as never,{
   factorId:challenge.factor_id,limitValue:5,expiresAt:challenge.mandate_expires_at,
  },g as never);
  expect(result).toMatchObject({limitValue:5,periodKind:"cafe_day"});
  expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(client.auth.mfa.challenge).toHaveBeenCalledWith({factorId:challenge.factor_id});
  expect(g.createMandateChallenge).toHaveBeenCalledWith(scope,expect.objectContaining({
   action:"grant",id:result.challengeId,mandateRevision:0,limitValue:5,policyHash:mandatePolicyHash(challenge.mandate_expires_at),
   factorId:challenge.factor_id,providerChallengeId:challenge.provider_challenge_id,
  }));
 });
 it("rejects any cap other than five before issuing a phone challenge",async()=>{
  const client=makeClient(),g=gateway();
  await expect(createMandateChallenge(scope,client as never,{
   factorId:challenge.factor_id,limitValue:4,expiresAt:challenge.mandate_expires_at,
  } as never,g as never)).rejects.toThrow("mandate_limit_must_be_5_per_cafe_day");
  expect(client.auth.getUser).not.toHaveBeenCalled();
  expect(client.auth.mfa.challenge).not.toHaveBeenCalled();
  expect(g.createMandateChallenge).not.toHaveBeenCalled();
 });
 it("does not issue a challenge for an unverified or non-phone factor",async()=>{
  const client=makeClient(),g=gateway();
  client.auth.mfa.listFactors.mockResolvedValue({data:{phone:[]},error:null} as never);
  await expect(createMandateChallenge(scope,client as never,{
   factorId:challenge.factor_id,limitValue:5,expiresAt:challenge.mandate_expires_at,
  },g as never)).rejects.toThrow("verified_phone_factor_required");
  expect(client.auth.mfa.challenge).not.toHaveBeenCalled();
  expect(g.createMandateChallenge).not.toHaveBeenCalled();
 });
 it("forwards OTP only to Auth verify and completes the exact stored server challenge",async()=>{
  const client=makeClient(),g=gateway();
  const mandate=await verifyMandateChallenge(scope,client as never,{challengeId:challenge.id,code:"123456"},g as never);
  expect(client.auth.mfa.verify).toHaveBeenCalledWith({
   factorId:challenge.factor_id,challengeId:challenge.provider_challenge_id,code:"123456"});
  expect(g.completeMandateChallenge).toHaveBeenCalledWith(scope,challenge);
  expect(mandate).toMatchObject({id:challenge.mandate_id,limit_value:5,capability_id:"leo.goal.v1"});
  expect(g.completeMandateChallenge.mock.calls[0]).toHaveLength(2);
 });
 it("rejects a consumed/expired challenge before asking Auth to verify",async()=>{
  const client=makeClient(),g=gateway();
  g.loadMandateChallenge.mockRejectedValue(new Error("Mandate challenge expired or consumed"));
  await expect(verifyMandateChallenge(scope,client as never,{challengeId:challenge.id,code:"123456"},g as never))
   .rejects.toThrow("expired or consumed");
  expect(client.auth.mfa.verify).not.toHaveBeenCalled();
  expect(g.completeMandateChallenge).not.toHaveBeenCalled();
 });
 it("rejects a different authenticated owner before verification",async()=>{
  const client=makeClient(),g=gateway();
  client.auth.getUser.mockResolvedValue({data:{user:{id:"99999999-9999-4999-8999-999999999999"}},error:null} as never);
  await expect(verifyMandateChallenge(scope,client as never,{challengeId:challenge.id,code:"123456"},g as never))
   .rejects.toThrow("authentication_required");
  expect(client.auth.mfa.verify).not.toHaveBeenCalled();
 });
 it("hashes the fixed five-start cap and expiry into the policy",()=>{
  expect(goalMandatePolicy.limitValue).toBe(5);
  expect(mandatePolicyHash(challenge.mandate_expires_at))
   .not.toBe(mandatePolicyHash("2026-12-02T00:00:00.000Z"));
 });
});
