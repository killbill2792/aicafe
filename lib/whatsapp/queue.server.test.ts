import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({
  rpc:vi.fn(),active:vi.fn(),allowed:vi.fn(),send:vi.fn(),
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({rpc:mocks.rpc})}));
vi.mock("./identity.server",()=>({activeBinding:mocks.active}));
vi.mock("./transport.server",()=>({providerAllowed:mocks.allowed,sendMeta:mocks.send}));
import {consumeInboundOnce,dispatchOutboundOnce,enqueueWhatsApp,
  recordSignedStatus,stableOwnerClientMessageId} from "./queue.server";
const U="123e4567-e89b-42d3-a456-426614174000";
const lease={wamid:"wamid.abc",binding_id:U,business_id:"cafe-A",
 owner_user_id:"owner-A",thread_id:"thread-A",kind:"button",
 text_content:null,button_payload:"money_went",media_id:null,
 lease_token:"lease-a",provider_at:"2026-10-31T09:00:00Z"};
const bound={id:U,businessId:"cafe-A",ownerUserId:"owner-A",threadId:"thread-A",
 waId:"15556506570",phoneNumberId:"1322195347653883",
 lastOwnerMessageAt:new Date().toISOString()};
beforeEach(()=>{
  process.env.WHATSAPP_INBOUND_DISPATCH_ENABLED="true";
  mocks.rpc.mockReset().mockImplementation(async(name:string)=>{
    if(name==="whatsapp_claim_inbound")return {data:lease,error:null};
    if(name==="whatsapp_claim_outbound")return {data:null,error:null};
    if(name==="whatsapp_finish_inbound"||name==="whatsapp_finish_outbound")
      return {data:true,error:null};
    if(name==="whatsapp_enqueue_outbound")return {data:U,error:null};
    return {data:null,error:null};
  });
  mocks.active.mockReset().mockResolvedValue(bound);
  mocks.allowed.mockReset().mockReturnValue(true);
  mocks.send.mockReset().mockResolvedValue({state:"accepted",wamid:"wamid.sent"});
});
afterEach(()=>delete process.env.WHATSAPP_INBOUND_DISPATCH_ENABLED);
describe("durable WhatsApp handoff",()=>{
  it("requires explicit PR C dispatcher and never independently starts the agent",async()=>{
    expect(await consumeInboundOnce()).toBe("disabled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("passes stable Meta-derived client ID, exact scope and question to shared adapter",async()=>{
    const dispatch=vi.fn(async()=>({ownerMessageId:U}));
    expect(stableOwnerClientMessageId("wamid.abc")).toBe(stableOwnerClientMessageId("wamid.abc"));
    expect(stableOwnerClientMessageId("wamid.other")).not.toBe(stableOwnerClientMessageId("wamid.abc"));
    expect(await consumeInboundOnce(dispatch)).toBe("done");
    expect(dispatch).toHaveBeenCalledWith({
      wamid:"wamid.abc",scope:{businessId:"cafe-A",ownerUserId:"owner-A"},
      threadId:"thread-A",clientMessageId:stableOwnerClientMessageId("wamid.abc"),
      kind:"button",prompt:"Where did my money go yesterday?",mediaId:null,
    });
    const final=mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_inbound");
    expect(final?.[1]).toMatchObject({p_state:"completed",p_owner_message_id:U});
  });
  it("does not deliver unauthorized or cross-cafe leased messages to dispatcher",async()=>{
    mocks.active.mockResolvedValueOnce({...bound,businessId:"cafe-B"});
    const dispatch=vi.fn();
    expect(await consumeInboundOnce(dispatch)).toBe("revoked");
    expect(dispatch).not.toHaveBeenCalled();
    const final=mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_inbound");
    expect(final?.[1]).toMatchObject({p_state:"failed",p_error:"binding_revoked"});
  });
  it("requeues on adapter failure, preserving the provider wamid for idempotent retries",async()=>{
    const dispatch=vi.fn(async()=>{throw new Error("mock agent outage");});
    expect(await consumeInboundOnce(dispatch)).toBe("retry");
    const final=mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_inbound");
    expect(final?.[1]).toMatchObject({p_wamid:"wamid.abc",p_state:"queued"});
  });
  it("only queues validated outbound payloads and requires source provenance",async()=>{
    const fields=["Cafe North","$10","1","Latte","1","verified event","Saturday"] as const;
    expect(await enqueueWhatsApp(U,"cafeA:2026-10-31:morning",{kind:"daily_brief",fields},
      {source:"canonical_daily_brief",period:"2026-10-30"},U,undefined,"2026-10-31")).toBe(U);
    const call=mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_enqueue_outbound");
    expect(call?.[1]).toMatchObject({p_kind:"daily_brief",p_binding_id:U,
      p_payload:{fields:[...fields]},p_business_date:"2026-10-31",p_source_message_id:U});
    await expect(enqueueWhatsApp(U,"invalid",{kind:"reply",text:"hi"},{},U)).rejects.toThrow("invalid_outbound");
  });
  it("rechecks binding before every send, and never sends when it is revoked",async()=>{
    const out={...lease,id:U,kind:"reply",payload:{text:"Allowed text"},
      wa_id:bound.waId,phone_number_id:bound.phoneNumberId};
    mocks.rpc.mockImplementation(async(name:string)=>{
      if(name==="whatsapp_claim_outbound")return {data:out,error:null};
      return {data:true,error:null};
    });
    mocks.active.mockResolvedValueOnce(null);
    expect(await dispatchOutboundOnce("reply")).toBe("failed");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_outbound")?.[1])
      .toMatchObject({p_outcome:"failed",p_error:"binding_revoked"});
  });
  it("never sends a reply outside the 24-hour service window",async()=>{
    const out={...lease,id:U,kind:"reply",payload:{text:"Allowed text"},
      wa_id:bound.waId,phone_number_id:bound.phoneNumberId};
    mocks.rpc.mockImplementation(async(name:string)=>{
      if(name==="whatsapp_claim_outbound")return {data:out,error:null};
      return {data:true,error:null};
    });
    mocks.active.mockResolvedValueOnce({...bound,lastOwnerMessageAt:"2020-01-01T00:00:00Z"});
    expect(await dispatchOutboundOnce("reply")).toBe("failed");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("records accepted separately from delivered, preserves uncertain outcomes",async()=>{
    const out={...lease,id:U,kind:"reply",payload:{text:"Allowed text"},
      wa_id:bound.waId,phone_number_id:bound.phoneNumberId};
    mocks.rpc.mockImplementation(async(name:string)=>{
      if(name==="whatsapp_claim_outbound")return {data:out,error:null};
      return {data:true,error:null};
    });
    expect(await dispatchOutboundOnce("reply")).toBe("accepted");
    expect(mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_outbound")?.[1])
      .toMatchObject({p_outcome:"accepted",p_provider_wamid:"wamid.sent"});
    mocks.rpc.mockClear();
    mocks.send.mockResolvedValueOnce({state:"uncertain",reason:"network_or_timeout_ambiguous"});
    expect(await dispatchOutboundOnce("reply")).toBe("uncertain");
    expect(mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_finish_outbound")?.[1])
      .toMatchObject({p_outcome:"uncertain",p_error:"network_or_timeout_ambiguous"});
    await recordSignedStatus({type:"status",wamid:"wamid.sent",state:"delivered"});
    expect(mocks.rpc.mock.calls.find(args=>args[0]==="whatsapp_record_status")?.[1])
      .toEqual({p_wamid:"wamid.sent",p_state:"delivered"});
  });
});
