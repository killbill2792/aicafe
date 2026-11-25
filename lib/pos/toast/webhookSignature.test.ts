import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createHmac} from "node:crypto";
import {validToastWebhookSignature,toastEventSchema,toastWebhookTarget} from "./webhookSignature";
it("verifies Toast HMAC-SHA256 over raw body plus exact event timestamp",()=>{
 const body='{"timestamp":"2026-10-12T18:01:01.000Z","guid":"00000000-0000-4000-8000-000000000001"}';
 const timestamp="2026-10-12T18:01:01.000Z";
 const sig=createHmac("sha256","subscription-secret").update(body+timestamp).digest("base64");
 const now=Date.parse(timestamp);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now)).toBe(true);
 expect(validToastWebhookSignature(body+" ",timestamp,sig,"subscription-secret",now)).toBe(false);
 expect(validToastWebhookSignature(body,timestamp,sig,"wrong-secret",now)).toBe(false);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now+600000)).toBe(true);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now+1200000)).toBe(true);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now+31*60000)).toBe(false);
});
it("rejects untrusted event types and absent restaurant GUID",()=>{
 const sample={guid:"00000000-0000-4000-8000-000000000001",timestamp:"2026-10-12T18:01:01.000Z",
   eventCategory:"orders",eventType:"order_updated",details:{}};
 expect(toastEventSchema.safeParse(sample).success).toBe(false);
 expect(toastEventSchema.safeParse({...sample,details:{restaurantGuid:"00000000-0000-4000-8000-000000000002"}}).success).toBe(true);
});

it("routes only supported event categories and retains the stock item identifier",()=>{
 const base={guid:"00000000-0000-4000-8000-000000000001",timestamp:"2026-10-12T18:01:01.000Z",
  details:{restaurantGuid:"00000000-0000-4000-8000-000000000002"}};
 const item="00000000-0000-4000-8000-000000000003";
 const stock=toastEventSchema.parse({...base,eventCategory:"stock",eventType:"in_stock",details:{...base.details,itemGuid:item}});
 expect(toastWebhookTarget(stock)).toEqual({kind:"stock",itemGuid:item});
 expect(toastWebhookTarget({...stock,eventCategory:"orders"})).toBeNull();
 expect(toastWebhookTarget(toastEventSchema.parse({...base,eventCategory:"menus",eventType:"menus_updated",details:{...base.details,publishedDate:base.timestamp}}))).toEqual({kind:"menus",version:base.timestamp});
});
