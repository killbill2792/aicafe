import {createHmac} from "node:crypto";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {GET,POST} from "./route";
const mocks=vi.hoisted(()=>({ingest:vi.fn(),status:vi.fn(),staffStatus:vi.fn(),staffInbound:vi.fn()}));
vi.mock("@/lib/whatsapp/identity.server",()=>({acceptSignedMessage:mocks.ingest}));
vi.mock("@/lib/whatsapp/queue.server",()=>({recordSignedStatus:mocks.status}));
vi.mock("@/lib/scheduling/staffPublication.server",()=>({recordSignedStaffScheduleStatus:mocks.staffStatus}));
vi.mock("@/lib/whatsapp/staffReplies.server",()=>({acceptSignedStaffText:mocks.staffInbound}));
const url="https://example.test/api/whatsapp/webhook";
const id="1322195347653883",secret="webhook-secret";
const event=(wamid="wamid.first",phoneId=id)=>({
  object:"whatsapp_business_account",entry:[{changes:[{field:"messages",
  value:{metadata:{phone_number_id:phoneId},messages:[{
    from:"15556506570",id:wamid,timestamp:"1793462400",type:"text",
    text:{body:"Where did my money go?"}}]}}]}],
});
function request(body:unknown,valid=true) {
  const raw=JSON.stringify(body);
  const digest=createHmac("sha256",secret).update(raw).digest("hex");
  return new Request(url,{method:"POST",headers:{"x-hub-signature-256":
    "sha256="+(valid?digest:"0".repeat(64))},body:raw});
}
beforeEach(()=>{
  process.env.WHATSAPP_VERIFY_TOKEN="verify";
  process.env.WHATSAPP_APP_SECRET=secret;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED;
  delete process.env.WHATSAPP_STAFF_SENDER_APPROVED;
  mocks.staffStatus.mockReset().mockResolvedValue(undefined);
  mocks.staffInbound.mockReset().mockResolvedValue("recorded");
  mocks.ingest.mockReset().mockResolvedValue("queued");
  mocks.status.mockReset().mockResolvedValue(undefined);
});
afterEach(()=>{
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  delete process.env.WHATSAPP_APP_SECRET;
});
describe("WhatsApp route",()=>{
  it("answers only correctly configured GET challenge",async()=>{
    expect(await (await GET(new Request(url+"?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123"))).text()).toBe("123");
    expect((await GET(new Request(url+"?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123"))).status).toBe(403);
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    expect((await GET(new Request(url+"?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123"))).status).toBe(403);
  });
  it("never persists forged or wrong-phone messages",async()=>{
    expect((await POST(request(event(),false))).status).toBe(401);
    expect((await POST(request(event("wamid.other","bad-phone")))).status).toBe(403);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("commits every signed message and status before returning 200",async()=>{
    const fixture=event();
    const value=fixture.entry[0].changes[0].value as Record<string,unknown>;
    value.statuses=[{id:"wamid.sent1",status:"sent"},{id:"wamid.sent2",status:"delivered"}];
    value.messages=[...(value.messages as unknown[]),{
      from:"15556506570",id:"wamid.second",timestamp:"1793462400",
      type:"button",button:{payload:"peak_today",text:"a different label"},
    }];
    const result=await POST(request(fixture));
    expect(result.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    expect(mocks.ingest.mock.calls[1][0]).toMatchObject({wamid:"wamid.second",payload:"peak_today"});
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
  it("accepts signed callbacks from an independent employee sender but never routes them as owner chat",async()=>{
    process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID="1555999888777666";
    process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED="true";
    process.env.WHATSAPP_STAFF_SENDER_APPROVED="true";
    const staffEvent=event("wamid.staff",process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID);
    const value=staffEvent.entry[0].changes[0].value as Record<string,unknown>;
    value.messages=[];
    value.statuses=[{id:"wamid.staff",status:"delivered"}];
    expect((await POST(request(staffEvent))).status).toBe(200);
    expect(mocks.staffStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      phoneId:"1555999888777666",wamid:"wamid.staff",state:"delivered",
    }));
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      wamid:"wamid.staff",state:"delivered",
    }));
    expect(mocks.ingest).not.toHaveBeenCalled();
    value.messages=[{
      from:"15556506570",id:"wamid.inbound",timestamp:"1793462400",
      type:"text",text:{body:"Approve the next shift"},
    }];
    expect((await POST(request(staffEvent))).status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.staffInbound).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind:"text",text:"Approve the next shift",wamid:"wamid.inbound",
      phoneId:"1555999888777666",
    }));
    // The signed employee inbound message never becomes an owner command,
    // but the co-batched genuine delivery callback MUST still be stored.
    expect(mocks.staffStatus).toHaveBeenCalledTimes(2);
    expect(mocks.status).toHaveBeenCalledTimes(2);
    // A sender policy pause does NOT revoke already issued Meta wamids.
    // Outbound effects stop; authenticated delayed receipts still reconcile.
    process.env.WHATSAPP_STAFF_SENDER_APPROVED="false";
    process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED="false";
    expect((await POST(request(staffEvent))).status).toBe(200);
    expect(mocks.staffStatus).toHaveBeenCalledTimes(3);
    expect(mocks.status).toHaveBeenCalledTimes(3);
    expect(mocks.staffInbound).toHaveBeenCalledTimes(3);
  });
  it("reconciles delivery when signed worker voice notes and foreign button payloads are co-batched",async()=>{
    process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID="1555999888777666";
    process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED="false";
    process.env.WHATSAPP_STAFF_SENDER_APPROVED="false";
    const e=event("wamid.ignored","1555999888777666");
    const value=e.entry[0].changes[0].value as Record<string,unknown>;
    value.messages=[{
      from:"15556506570",id:"wamid.voice",timestamp:"1793462400",
      type:"audio",audio:{id:"voice-file"},
    },{
      from:"15556506570",id:"wamid.worker-button",timestamp:"1793462400",
      type:"button",button:{payload:"worker_shift_acknowledged",text:"ok"},
    }];
    value.statuses=[{id:"wamid.real",status:"delivered"},{id:"wamid.second",status:"read"}];
    expect((await POST(request(e))).status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.staffInbound).not.toHaveBeenCalled();
    expect(mocks.status.mock.calls.map(args=>args[0].wamid)).toEqual([
      "wamid.real","wamid.second",
    ]);
    expect(mocks.staffStatus.mock.calls.map(args=>args[0].state)).toEqual([
      "delivered","read",
    ]);
  });
  it("preserves owner and staff receipts in a signed mixed-sender batch while sends are disabled",async()=>{
    process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID="1555999888777666";
    const staff=event("wamid.incoming","1555999888777666");
    const value=staff.entry[0].changes[0].value as Record<string,unknown>;
    value.messages=[{
      from:"15556506570",id:"wamid.worker-sticker",timestamp:"1793462400",
      type:"sticker",sticker:{id:"sticker-id"},
    }];
    value.statuses=[{id:"wamid.employee-delivered",status:"delivered"}];
    const owner=event("wamid.owner-message");
    const combined={
      object:"whatsapp_business_account",
      entry:[{changes:[...staff.entry[0].changes,...owner.entry[0].changes]}],
    };
    expect((await POST(request(combined))).status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledOnce();
    expect(mocks.ingest.mock.calls[0][0]).toMatchObject({wamid:"wamid.owner-message"});
    expect(mocks.staffStatus).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(mocks.staffInbound).not.toHaveBeenCalled();
    expect(mocks.status.mock.calls[0][0]).toMatchObject({wamid:"wamid.employee-delivered"});
    // A configured sender identity is still exact: different/forged phone fails.
    const stranger=event("wamid.attacker","1555999888777667");
    expect((await POST(request(stranger))).status).toBe(403);
  });
  it("refuses unverified staff callback signatures before any receipt write",async()=>{
    process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID="1555999888777666";
    process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED="true";
    process.env.WHATSAPP_STAFF_SENDER_APPROVED="true";
    const staffEvent=event("wamid.staff","1555999888777666");
    const value=staffEvent.entry[0].changes[0].value as Record<string,unknown>;
    value.messages=[];value.statuses=[{id:"wamid.staff",status:"read"}];
    expect((await POST(request(staffEvent,false))).status).toBe(401);
    expect(mocks.staffStatus).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.staffInbound).not.toHaveBeenCalled();
  });
  it("duplicate signed webhook remains 200 without a second queued owner turn",async()=>{
    const ids=new Set<string>();
    mocks.ingest.mockImplementation(async(e:{wamid:string})=>{
      if(ids.has(e.wamid))return "duplicate";
      ids.add(e.wamid);return "queued";
    });
    expect((await POST(request(event()))).status).toBe(200);
    expect((await POST(request(event()))).status).toBe(200);
    expect(ids.size).toBe(1);
  });
  it("unknown/revoked owner causes no AI dispatch or provider send",async()=>{
    mocks.ingest.mockResolvedValue("unauthorized");
    expect((await POST(request(event()))).status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledOnce();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("returns 503 on persistence failure, allowing Meta replay",async()=>{
    mocks.ingest.mockRejectedValueOnce(new Error("DB offline"));
    expect((await POST(request(event()))).status).toBe(503);
    expect((await POST(request(event()))).status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
  });
  it("rejects payloads exceeding maximum raw bytes",async()=>{
    const body=" ".repeat(128*1024+1);
    const digest=createHmac("sha256",secret).update(body).digest("hex");
    const res=await POST(new Request(url,{method:"POST",headers:{
      "x-hub-signature-256":"sha256="+digest},body}));
    expect(res.status).toBe(413);
  });
});
