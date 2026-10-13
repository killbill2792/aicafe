import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createHmac} from "node:crypto";
import {validToastWebhookSignature,toastEventSchema} from "./webhookSignature";
it("verifies Toast HMAC-SHA256 over raw body plus exact event timestamp",()=>{
 const body='{"timestamp":"2026-10-12T18:01:01.000Z","guid":"00000000-0000-4000-8000-000000000001"}';
 const timestamp="2026-10-12T18:01:01.000Z";
 const sig=createHmac("sha256","subscription-secret").update(body+timestamp).digest("base64");
 const now=Date.parse(timestamp);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now)).toBe(true);
 expect(validToastWebhookSignature(body+" ",timestamp,sig,"subscription-secret",now)).toBe(false);
 expect(validToastWebhookSignature(body,timestamp,sig,"wrong-secret",now)).toBe(false);
 expect(validToastWebhookSignature(body,timestamp,sig,"subscription-secret",now+600000)).toBe(false);
});
it("rejects untrusted event types and absent restaurant GUID",()=>{
 const sample={guid:"00000000-0000-4000-8000-000000000001",timestamp:"2026-10-12T18:01:01.000Z",
   eventCategory:"orders",eventType:"order_updated",details:{}};
 expect(toastEventSchema.safeParse(sample).success).toBe(false);
 expect(toastEventSchema.safeParse({...sample,details:{restaurantGuid:"00000000-0000-4000-8000-000000000002"}}).success).toBe(true);
});
