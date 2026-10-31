import {createHmac} from "node:crypto";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {GET,POST} from "./route";
const mocks=vi.hoisted(()=>({ingest:vi.fn(),status:vi.fn()}));
vi.mock("@/lib/whatsapp/identity.server",()=>({acceptSignedMessage:mocks.ingest}));
vi.mock("@/lib/whatsapp/queue.server",()=>({recordSignedStatus:mocks.status}));
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
