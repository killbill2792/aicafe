import {beforeEach,describe,expect,it,vi} from "vitest";
const mock=vi.hoisted(()=>({
 run:vi.fn(),start:vi.fn(),finish:vi.fn(),find:vi.fn(),register:vi.fn(),
 provenance:vi.fn(),scope:vi.fn(),quota:vi.fn(),access:vi.fn(),
}));
const owner={id:"33333333-3333-4333-8333-333333333333",threadId:"22222222-2222-4222-8222-222222222222",
 role:"owner",contentType:"text",text:"Where did my money go yesterday?",clientMessageId:"44444444-4444-4444-8444-444444444444",
 blocks:null,grounding:null,createdAt:"2026-10-29T08:00:00Z"};
vi.mock("@/lib/ai/conversations/authorizedTurn.server",()=>({
 authorizedExternalConversation:mock.scope,externalOwnerClientMessageId:()=>owner.clientMessageId,
 registerAuthorizedSupervisorTurn:mock.register,markWhatsAppOwnerProvenance:mock.provenance,
 storedOwnerMessageChannel:()=>Promise.resolve("whatsapp"),
}));
vi.mock("@/lib/ai/conversations/usage.server",()=>({assertOwnerAgentTurnAvailable:mock.quota}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:mock.access}));
vi.mock("@/lib/ai/conversations/enabled.server",()=>({
 isSupervisorChatConfigured:()=>true,getSupervisorChatReadiness:async()=>({enabled:true,reason:null}),
}));
vi.mock("@/lib/ai/conversations/agentRunner.server",()=>({
 runOneTurn:mock.run,errorCode:()=> "agent_turn_failed",
}));
vi.mock("@/lib/ai/agent/jobs.server",()=>({
 startAgentJob:mock.start,finishAgentJob:mock.finish,readOwnerMessage:mock.find,
}));
vi.mock("@/lib/supabase/admin",()=>({
 createAdminSupabaseClient:()=>({from:()=>({
   select:()=>({eq:()=>({eq:()=>({eq:()=>({eq:()=>({
     single:async()=>({data:{grounding:{sourceChannel:"whatsapp",receivedAt:"2026-10-29T08:00:00.000Z"}},error:null}),
   })})})})}),
 })}),
}));
import {processVerifiedWhatsAppOwnerTurn} from "./supervisor.server";
const input={scope:{businessId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
 threadId:owner.threadId,wamid:"wamid.HBg123",receivedAt:"2026-10-29T08:00:00Z",
 locale:"en" as const,input:{type:"button" as const,payload:"money_went"}};
describe("verified WhatsApp Supervisor worker",()=>{
 beforeEach(()=>{
   vi.clearAllMocks();process.env.WHATSAPP_SUPERVISOR_ENABLED="true";
   mock.scope.mockResolvedValue({getThread:async()=>({id:owner.threadId})});
   mock.register.mockResolvedValue({owner,prior:null,thread:{id:owner.threadId}});
   mock.start.mockResolvedValue({mode:"started",job:{id:"job1",ownerMessageId:owner.id}});
   mock.run.mockResolvedValue({replyId:"reply1",replyText:"Verified sales: $100",absorbedOwnerMessageIds:[]});
   mock.finish.mockResolvedValue({continuation:null});
 });
 it("fails closed by default, without a provider send or job",async()=>{
   delete process.env.WHATSAPP_SUPERVISOR_ENABLED;
   await expect(processVerifiedWhatsAppOwnerTurn(input)).rejects.toThrow("whatsapp_supervisor_disabled");
   expect(mock.start).not.toHaveBeenCalled();
 });
 it("maps the payload and persists only one shared Supervisor reply",async()=>{
   const result=await processVerifiedWhatsAppOwnerTurn(input);
   expect(mock.register).toHaveBeenCalledWith(expect.objectContaining({
     threadId:input.threadId,text:"Where did my money go yesterday?",
   }));
   expect(mock.run).toHaveBeenCalledTimes(1);
   expect(mock.run).toHaveBeenCalledWith(expect.objectContaining({externalClient:expect.anything(),
      ownerText:owner.text,threadId:input.threadId}));
   expect(result).toMatchObject({status:"answered",completed:[{ownerMessageId:owner.id,replyId:"reply1",
     replyText:"Verified sales: $100",eligibleAtCompletion:false}]});
   expect(mock.finish).toHaveBeenCalledWith("job1",{status:"done",replyMessageId:"reply1"});
 });
 it("never hands another WhatsApp owner's queued answer to this inbound reply",async()=>{
   const nextOwner={...owner,id:"55555555-5555-4555-8555-555555555555",text:"Other WA question"};
   mock.finish.mockResolvedValueOnce({continuation:{id:"job2",ownerMessageId:nextOwner.id}})
     .mockResolvedValueOnce({continuation:null});
   mock.find.mockResolvedValue(nextOwner);
   mock.run.mockResolvedValueOnce({replyId:"reply1",replyText:"Original reply",absorbedOwnerMessageIds:[]})
     .mockResolvedValueOnce({replyId:"reply2",replyText:"Another inbound reply",absorbedOwnerMessageIds:[]});
   const result=await processVerifiedWhatsAppOwnerTurn(input);
   expect(mock.run).toHaveBeenCalledTimes(2);
   expect(result.completed).toEqual([expect.objectContaining({
     ownerMessageId:owner.id,replyId:"reply1",replyText:"Original reply",
   })]);
 });
 it("does not start a duplicate agent when the canonical job was attached",async()=>{
   mock.start.mockResolvedValue({mode:"attached",job:{id:"job1"}});
   expect(await processVerifiedWhatsAppOwnerTurn(input)).toEqual({status:"queued",completed:[]});
   expect(mock.run).not.toHaveBeenCalled();
 });
 it("replays the same verified stored answer without re-running the model",async()=>{
   mock.register.mockResolvedValue({owner,prior:{id:"reply1",blocks:[{type:"text",text:"Already answered"}]}});
   const result=await processVerifiedWhatsAppOwnerTurn(input);
   expect(result.status).toBe("replayed");
   expect(result.completed[0].replyText).toBe("Already answered");
   expect(mock.run).not.toHaveBeenCalled();
   expect(mock.start).not.toHaveBeenCalled();
 });
 it("rejects arbitrary unknown reply payload without entering the model",async()=>{
   await expect(processVerifiedWhatsAppOwnerTurn({...input,input:{type:"button",payload:"approve"}}))
     .rejects.toThrow("unknown_whatsapp_button_payload");
   expect(mock.register).not.toHaveBeenCalled();
 });
});
