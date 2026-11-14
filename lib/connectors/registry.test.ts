import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {allowsGmail,assertGmailCapability,digest,type ConnectorAccount} from "./registry.server";
const account:ConnectorAccount={id:"11111111-1111-4111-8111-111111111111",
 businessId:"22222222-2222-4222-8222-222222222222",ownerUserId:"33333333-3333-4333-8333-333333333333",
 provider:"gmail",provider_subject:"google-subject",email:"owner@example.com",
 granted_scopes:["openid","email","https://www.googleapis.com/auth/gmail.modify"],
 enabled_operations:["read","draft","send","organize"],status:"active",generation:1};
describe("service-only connector operations",()=>{
 it("grants all ordinary operations only with the explicit internal grant",()=>{
   for(const operation of ["read","draft","send","organize"] as const){
     expect(allowsGmail(account,operation)).toBe(true);
   }
   expect(allowsGmail({...account,enabled_operations:["read"]},"send")).toBe(false);
   expect(allowsGmail({...account,granted_scopes:["openid","email"]},"read")).toBe(false);
 });
 it("rejects revoked, reconnect-needed, and absent accounts",()=>{
   expect(allowsGmail(null,"read")).toBe(false);
   for(const status of ["revoking","disconnected","needs_reconnect"] as const){
     expect(allowsGmail({...account,status},"read")).toBe(false);
     expect(()=>assertGmailCapability({...account,status},"send")).toThrow("not_authorized");
   }
 });
 it("hashes OAuth state without persisting its plaintext",()=>{
   const state="a secure unpredictable OAuth challenge";
   expect(digest(state)).toMatch(/^[a-f0-9]{64}$/);
   expect(digest(state)).not.toContain(state);
   expect(digest(state)).toBe(digest(state));
 });
});
