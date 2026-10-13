import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {toastRetryAt,trustedToastOrigin} from "./client";
import {verificationFailure} from "@/app/api/pos/toast/test/route";
import {setupSchema} from "./ownerAccess";
it("does not compress Toast's required 15-minute retry to an unsafe immediate retry",()=>{
 const until=toastRetryAt(new Response("",{status:429,headers:{"Retry-After":"900"}}),1000);
 expect(new Date(until).getTime()).toBe(901000);
});
it("respects both rate-limit reset and Retry-After",()=>{
 const res=new Response("",{status:429,headers:{"Retry-After":"25","X-Toast-RateLimit-Reset":"1000"}});
 expect(new Date(toastRetryAt(res,100000)).getTime()).toBe(1000000);
});
it("preserves verified connection status on temporary failures",()=>{
 for(const category of ["unavailable","timeout","rate_limited","invalid_response"])
  expect(verificationFailure(true,category)).toEqual({state:"verified",preserveVerification:true});
 expect(verificationFailure(true,"authentication")).toEqual({state:"needs_reconnect",preserveVerification:false});
 expect(verificationFailure(true,"missing_permissions")).toEqual({state:"missing_permissions",preserveVerification:false});
 expect(verificationFailure(true,"unauthorized_location")).toEqual({state:"configured",preserveVerification:false});
});
it("rejects duplicate mappings, structurally invalid GUIDs, unknown keys",()=>{
 const good={businessId:"00000000-0000-4000-8000-000000000001",
  apiUrl:"https://ws-api.toasttab.com",clientId:"id",clientSecret:"secret",
  locations:[{location_id:"00000000-0000-4000-8000-000000000002",restaurant_guid:"00000000-0000-4000-8000-000000000003"}]};
 expect(setupSchema.safeParse(good).success).toBe(true);
 expect(setupSchema.safeParse({...good,businessId:"not-guid"}).success).toBe(false);
 expect(setupSchema.safeParse({...good,locations:[{...good.locations[0],restaurant_guid:"abcd"}]}).success).toBe(false);
 expect(setupSchema.safeParse({...good,injected:true}).success).toBe(false);
});
it("rejects SSRF URL tricks",()=>{
 expect(()=>trustedToastOrigin("https://ws-api.toasttab.com.evil.test","ws-api.toasttab.com")).toThrow();
 expect(()=>trustedToastOrigin("https://ws-api.toasttab.com/?redirect=https://bad.test","ws-api.toasttab.com")).toThrow();
});
