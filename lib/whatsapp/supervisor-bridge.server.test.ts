import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({
 row:null as Record<string,unknown>|null,
 binding:null as Record<string,unknown>|null,
 ready:[] as Record<string,unknown>[],
 messages:[] as Record<string,unknown>[],
 process:vi.fn(),download:vi.fn(),save:vi.fn(),enqueue:vi.fn(),
 consume:vi.fn(),send:vi.fn(),
}));
const cafe="11111111-1111-4111-8111-111111111111";
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const thread="22222222-2222-4222-8222-222222222222";
const providerId="wamid.HBgABA==";
const ownerMessageId="33333333-3333-4333-8333-333333333333";
const replyId="44444444-4444-4444-8444-444444444444";
const bindingId="55555555-5555-4555-8555-555555555555";
const clientMessageId="66666666-6666-5666-8666-666666666666";
const receivedAt=new Date(Date.now()-90_000).toISOString();
const db={
 from:(table:string)=>{
   const query={
     select:()=>query,eq:()=>query,in:()=>query,
     maybeSingle:async()=>({data:table==="whatsapp_inbound"?m.row:null,error:null}),
     limit:async()=>({data:table==="ai_messages"?m.messages:[],error:null}),
   };
   return query;
 },
 rpc:async()=>({data:m.ready,error:null}),
};
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>db}));
vi.mock("./identity.server",()=>({activeBinding:async()=>m.binding}));
vi.mock("./queue.server",()=>({
 stableOwnerClientMessageId:()=>clientMessageId,enqueueWhatsApp:m.enqueue,
 consumeInboundOnce:m.consume,dispatchOutboundOnce:m.send,
}));
vi.mock("./media.server",()=>({downloadWhatsAppMedia:m.download,saveWhatsAppMediaDraft:m.save}));
vi.mock("./supervisor.server",()=>({processVerifiedWhatsAppOwnerTurn:m.process}));
import {dispatchVerifiedWhatsAppInbound,reconcileWhatsAppSupervisorReplies,
 runWhatsAppSupervisorWorker} from "./supervisor-bridge.server";
const transportMessage={
 wamid:providerId,scope:{businessId:cafe,ownerUserId:owner},threadId:thread,
 clientMessageId,kind:"button" as const,prompt:"Where did my money go yesterday?",mediaId:null,
};
function setMessages(text="Verified net sales: $100"){
 m.messages=[
  {id:ownerMessageId,role:"owner",content_type:"text",client_message_id:clientMessageId,
   grounding:{sourceChannel:"whatsapp",receivedAt:receivedAt}},
  {id:replyId,role:"supervisor",content_type:"blocks",
   grounding:{ownerMessageId},structured_content:[{type:"text",text}]},
 ];
}
function readyRow(){
 return {wamid:providerId,binding_id:bindingId,business_id:cafe,
  owner_user_id:owner,thread_id:thread,owner_message_id:ownerMessageId,
  reply_id:replyId,provider_at:receivedAt};
}
beforeEach(()=>{
 vi.clearAllMocks();
 process.env.WHATSAPP_SUPERVISOR_ENABLED="true";
 process.env.WHATSAPP_WORKER_ENABLED="true";
 process.env.META_WHATSAPP_TOKEN="test-token";
 m.row={wamid:providerId,binding_id:bindingId,business_id:cafe,
  owner_user_id:owner,thread_id:thread,kind:"button",
  text_content:null,button_payload:"money_went",media_id:null,
  provider_at:receivedAt,state:"leased"};
 m.binding={id:bindingId,businessId:cafe,ownerUserId:owner,threadId:thread,
  lastOwnerMessageAt:receivedAt};
 m.process.mockResolvedValue({status:"answered",ownerMessageId,completed:[]});
 m.download.mockResolvedValue({bytes:new TextEncoder().encode("%PDF-1.7"),
   mimeType:"application/pdf",name:"receipt.pdf"});
 m.save.mockResolvedValue({attachmentId:"77777777-7777-4777-8777-777777777777",state:"stored_unanalysed"});
 m.enqueue.mockResolvedValue("88888888-8888-4888-8888-888888888888");
 m.consume.mockImplementation(async(dispatcher:typeof dispatchVerifiedWhatsAppInbound)=>{
   await dispatcher(transportMessage);
   return "done";
 });
 m.send.mockResolvedValue("disabled");
 m.ready=[readyRow()];
 setMessages();
});
describe("PR A signed durable dispatch -> ONE Supervisor",()=>{
 it.each([
  ["money_went","Where did my money go yesterday?"],
  ["peak_today","What are my usual busiest hours for today?"],
  ["slowest_yesterday","What was my slowest hour yesterday?"],
  ["event_today","Tell me more about today's saved nearby event."],
 ])("maps %s by raw payload, NOT by label",async(payload,question)=>{
  m.row={...m.row,button_payload:payload};
  const result=await dispatchVerifiedWhatsAppInbound({...transportMessage,prompt:question});
  expect(result).toEqual({ownerMessageId});
  expect(m.process).toHaveBeenCalledWith(expect.objectContaining({
    clientMessageId,threadId:thread,input:{type:"button",payload},
    scope:{businessId:cafe,ownerUserId:owner},
  }));
 });
 it("sends arbitrary multilingual owner text to the same Supervisor without keyword routing",async()=>{
  const text="¿Cuánto gastamos ayer? and هل نفدت القهوة؟";
  m.row={...m.row,kind:"text",text_content:text,button_payload:null};
  await dispatchVerifiedWhatsAppInbound({...transportMessage,kind:"text",prompt:text});
  expect(m.process).toHaveBeenCalledWith(expect.objectContaining({
    input:{type:"text",text},
  }));
 });
 it("fails closed on wrong selected café, verified phone binding, or wrong thread",async()=>{
  m.binding={...m.binding,businessId:"99999999-9999-4999-8999-999999999999"};
  await expect(dispatchVerifiedWhatsAppInbound(transportMessage)).rejects.toThrow("binding_revoked");
  expect(m.process).not.toHaveBeenCalled();
  m.binding={...m.binding,businessId:cafe};
  await expect(dispatchVerifiedWhatsAppInbound({...transportMessage,
    threadId:"99999999-9999-4999-8999-999999999999"}))
    .rejects.toThrow("inbound_scope_mismatch");
  expect(m.process).not.toHaveBeenCalled();
 });
 it("refuses a second client-message key from a forged source",async()=>{
  await expect(dispatchVerifiedWhatsAppInbound({...transportMessage,
    clientMessageId:"77777777-7777-4777-8777-777777777777"}))
    .rejects.toThrow("invalid_whatsapp_client_key");
  expect(m.process).not.toHaveBeenCalled();
 });
 it("sends photo/PDF through existing private attachment draft, then same owner turn",async()=>{
  for(const kind of ["image","document"] as const){
    m.row={...m.row,kind,media_id:"123",button_payload:null};
    m.download.mockResolvedValueOnce({mimeType:kind==="image"?"image/jpeg":"application/pdf",
      bytes:new Uint8Array([1,2,3]),name:kind==="image"?"receipt.jpg":"receipt.pdf"});
    await dispatchVerifiedWhatsAppInbound({...transportMessage,kind,mediaId:"123",prompt:null});
    expect(m.download).toHaveBeenCalledWith({mediaId:"123",kind},"test-token");
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({
      scope:transportMessage.scope,threadId:thread,wamid:providerId,
    }));
    expect(m.process).toHaveBeenCalledWith(expect.objectContaining({
      input:{type:"media",kind},
      attachmentIds:["77777777-7777-4777-8777-777777777777"],
    }));
  }
 });
 it("reports unsupported media honestly, but never marks a transient download error as unsupported",async()=>{
  m.row={...m.row,kind:"document",media_id:"123",button_payload:null};
  m.download.mockRejectedValueOnce(new Error("unsupported_whatsapp_media"));
  await dispatchVerifiedWhatsAppInbound({...transportMessage,kind:"document",mediaId:"123",prompt:null});
  const arg=m.process.mock.calls[0][0];
  expect(arg.input.text).toContain("cannot inspect");
  expect(arg.attachmentIds).toBeUndefined();
  expect(m.save).not.toHaveBeenCalled();
  m.process.mockClear();
  m.download.mockRejectedValueOnce(new Error("meta_media_download_failed"));
  await expect(dispatchVerifiedWhatsAppInbound({...transportMessage,kind:"document",mediaId:"123",prompt:null}))
    .rejects.toThrow("meta_media_download_failed");
  expect(m.process).not.toHaveBeenCalled();
 });
 it("never processes inbound while feature disabled",async()=>{
  delete process.env.WHATSAPP_SUPERVISOR_ENABLED;
  await expect(dispatchVerifiedWhatsAppInbound(transportMessage)).rejects.toThrow("disabled");
  expect(m.process).not.toHaveBeenCalled();
 });
});
describe("durable web/WA reply reconciliation",()=>{
 it("enqueues exact persisted website-visible response with one scoped delivery key",async()=>{
  expect(await reconcileWhatsAppSupervisorReplies()).toEqual({enqueued:1,skipped:0});
  expect(m.enqueue).toHaveBeenCalledWith(bindingId,expect.stringMatching(/^whatsapp:reply:[a-f0-9]{64}$/),
    {kind:"reply",text:"Verified net sales: $100"},
    expect.objectContaining({source:"ai_messages",replyMessageId:replyId}),
    replyId,providerId);
 });
 it("queues a reply completed later by web without running Supervisor a second time",async()=>{
  m.process.mockResolvedValueOnce({status:"queued",ownerMessageId,completed:[]});
  m.ready=[];
  m.consume.mockImplementationOnce(async(dispatcher:typeof dispatchVerifiedWhatsAppInbound)=>{
    expect(await dispatcher(transportMessage)).toEqual({ownerMessageId});
    // PR A has durably marked inbound complete; web worker has not replied yet.
    return "done";
  });
  const first=await runWhatsAppSupervisorWorker();
  expect(first).toMatchObject({inbound:"done",replyQueue:{enqueued:0}});
  m.ready=[readyRow()];setMessages("This is the later website response");
  m.consume.mockResolvedValueOnce("empty");
  const second=await runWhatsAppSupervisorWorker();
  expect(second.replyQueue.enqueued).toBe(1);
  expect(m.enqueue).toHaveBeenCalledWith(bindingId,expect.any(String),
    {kind:"reply",text:"This is the later website response"},
    expect.any(Object),replyId,providerId);
  expect(m.process).toHaveBeenCalledTimes(1); // reconciliation never re-asks the model
 });
 it("outbound SQL dedupe removes already queued rows on subsequent ticks",async()=>{
  await reconcileWhatsAppSupervisorReplies();
  m.ready=[];
  await reconcileWhatsAppSupervisorReplies();
  expect(m.enqueue).toHaveBeenCalledTimes(1);
 });
 it("fails closed for missing source provenance, expired window, and overlong answer",async()=>{
  m.messages[1]={...m.messages[1],grounding:{ownerMessageId:"99999999-9999-4999-8999-999999999999"}};
  await expect(reconcileWhatsAppSupervisorReplies()).rejects.toThrow("provenance_conflict");
  setMessages("ok");
  m.binding={...m.binding,lastOwnerMessageAt:new Date(Date.now()-25*3600_000).toISOString()};
  expect(await reconcileWhatsAppSupervisorReplies()).toEqual({enqueued:0,skipped:1});
  m.binding={...m.binding,lastOwnerMessageAt:receivedAt};
  setMessages("x".repeat(4097));
  expect(await reconcileWhatsAppSupervisorReplies()).toEqual({enqueued:0,skipped:1});
  expect(m.enqueue).not.toHaveBeenCalled();
 });
 it("never crosses café even with a falsely scoped ready-reply RPC result",async()=>{
  m.ready=[{...readyRow(),business_id:"99999999-9999-4999-8999-999999999999"}];
  expect(await reconcileWhatsAppSupervisorReplies()).toEqual({enqueued:0,skipped:1});
  expect(m.enqueue).not.toHaveBeenCalled();
 });
});
