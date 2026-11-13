import {describe,expect,it,vi} from "vitest";
import {commitLoop,effectHash,loopRegistry,type RegisteredLoopCapability,type LoopProposal} from "./engine";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const effect={accountId:"44444444-4444-4444-8444-444444444444",
 generation:1,operation:"send",from:"owner@example.com",to:["supplier@example.org"],subject:"Order",body:"Approved"};
const makeProposal=(status:LoopProposal["status"],revision:number):LoopProposal=>({
 id:"55555555-5555-4555-8555-555555555555",businessId:scope.businessId,
 ownerUserId:scope.ownerUserId,threadId:scope.threadId,capabilityId:"alex.gmail_effect.v1",
 capabilityVersion:1,canonicalEffectPayload:effect,effectHash:effectHash(effect),
 baseline:{},monitorSpec:{durationDays:1,metricScope:"gmail"},status,revision,
 locale:"en",monitoringStartDate:null,createdAt:"2026-11-12T01:00:00Z"
});
function setup(commit:RegisteredLoopCapability["commit"]){
 const capability:RegisteredLoopCapability={
   id:"alex.gmail_effect.v1",version:1,proposalInputJsonSchema:{},
   proposalDescription:"fake Gmail",simulate:async()=>({effect,baseline:{},monitorSpec:{durationDays:1,metricScope:"gmail"}}),
   parseEffect:raw=>raw as typeof effect,dependencyScope:()=>({accountId:effect.accountId}),
   commit,monitor:async()=>null,
   report:async()=>({status:"complete",result:{},recommendation:"keep",source:"gmail"})
 };
 return loopRegistry(capability);
}
describe("existing Supervisor gateway never retries Gmail after an uncertain send",()=>{
 it("reserves the effect before invoking the provider and records uncertain on timeout",async()=>{
   const send=vi.fn().mockRejectedValue(new Error("provider timeout"));
   const gateway=setup(send);
   let status:LoopProposal["status"]="approved";
   const finish=vi.fn(async()=>{status="executing";return makeProposal("executing",3);});
   const repo={
     load:vi.fn(async()=>makeProposal(status,status==="approved"?2:3)),
     claimEffect:vi.fn(async()=>({proposal:makeProposal("executing",3),
       attemptKey:"66666666-6666-4666-8666-666666666666",businessDate:"2026-11-12",authorizationKind:"click"})),
     finishEffect:finish
   };
   await expect(commitLoop(scope,gateway,repo as never,makeProposal("approved",2).id,2,"click"))
     .rejects.toThrow("provider timeout");
   expect(repo.claimEffect).toHaveBeenCalledTimes(1);
   expect(send).toHaveBeenCalledTimes(1);
   expect(finish).toHaveBeenCalledWith(scope,expect.anything(),3,"uncertain");
   await expect(commitLoop(scope,gateway,repo as never,makeProposal("approved",2).id,3,"click"))
     .rejects.toThrow("Approval required");
   expect(send).toHaveBeenCalledTimes(1);
 });
 it("rejects an unapproved Gmail send without ever reaching the provider",async()=>{
   const send=vi.fn(),gateway=setup(send);
   const repo={load:async()=>makeProposal("draft",1)};
   await expect(commitLoop(scope,gateway,repo as never,makeProposal("draft",1).id,1,"click"))
     .rejects.toThrow("Approval required");
   expect(send).not.toHaveBeenCalled();
 });
});
