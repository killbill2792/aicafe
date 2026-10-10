import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
import {notificationEnabled,safeTaskKind,deliverOwnerTemplate} from "./whatsapp.server";
afterEach(()=>{delete process.env.AI_CAFE_WHATSAPP_ENABLED;delete process.env.META_WHATSAPP_TOKEN;
 delete process.env.META_WHATSAPP_PHONE_ID;delete process.env.CRON_SECRET;});
describe("Proactive WhatsApp owner alert safety",()=>{
 it("defaults off and never sends if credentials absent",async()=>{
  const send=vi.fn();
  expect(notificationEnabled()).toBe(false);
  expect(await deliverOwnerTemplate("+15555550123","menu price review",send)).toEqual({
   sent:false,reason:"provider_unavailable"});
  expect(send).not.toHaveBeenCalled();
 });
 it("limits notification content to the persisted task kind and pending owner status",()=>{
  expect(safeTaskKind({kind:"price_review",status:"needs_owner"})).toBe("menu price review");
  expect(safeTaskKind({kind:"price_review",status:"handled"})).toBeNull();
  expect(safeTaskKind({kind:"money_update",status:"needs_response"})).toBeNull();
 });
 it("only accepts provider receipts as actual sends",async()=>{
  process.env.AI_CAFE_WHATSAPP_ENABLED="true";process.env.META_WHATSAPP_TOKEN="token";
  process.env.META_WHATSAPP_PHONE_ID="123";process.env.CRON_SECRET="secret";
  const send=vi.fn(async (_url:string,options:RequestInit)=>
    ({ok:true,json:async()=>({messages:[{id:"wamid.abc"}]}),body:options.body}));
  expect(await deliverOwnerTemplate("+15555550123","menu price review",send as unknown as typeof fetch))
   .toEqual({sent:true,providerId:"wamid.abc"});
  const payload=JSON.parse(String(send.mock.calls[0][1].body)) as {type:string;template:{name:string}};
  expect(payload.type).toBe("template");
  expect(payload.template.name).toBe("ai_cafe_owner_task_alert");
  expect(await deliverOwnerTemplate("+15555550123","confidential staff name",send as unknown as typeof fetch))
   .toEqual({sent:false,reason:"invalid_task"});
  expect(send).toHaveBeenCalledTimes(1);
 });
});
