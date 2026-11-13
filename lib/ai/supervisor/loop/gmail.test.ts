import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({getAccount:vi.fn(),send:vi.fn()}));
vi.mock("@/lib/connectors/registry.server",()=>({
  getConnectorAccount:mocks.getAccount,
  assertGmailCapability:(account:unknown)=>{if(!account)throw Error("gmail_not_authorized");}
}));
vi.mock("@/lib/connectors/gmail/provider.server",()=>({performGmailEffect:mocks.send}));
import {gmailCapability,gmailCapabilityId} from "./gmail.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"22222222-2222-4222-8222-222222222222",
  threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const input={operation:"send" as const,action:null,to:["supplier@example.net"],cc:[],bcc:[],
 subject:"Confirmation",body:"Approved.",messageId:null,threadId:null,labelId:null,labelName:null};
describe("registered Gmail Supervisor capability",()=>{
 it("simulates an inert owner-scoped effect with immutable account generation",async()=>{
   mocks.getAccount.mockResolvedValue({id:"44444444-4444-4444-8444-444444444444",
     generation:4,email:"owner@example.com"});
   const simulated=await gmailCapability.simulate(scope,input);
   expect(gmailCapability.id).toBe(gmailCapabilityId);
   expect(simulated.effect).toMatchObject({accountId:"44444444-4444-4444-8444-444444444444",
     generation:4,from:"owner@example.com"});
   expect(mocks.send).not.toHaveBeenCalled();
 });
 it("rejects a conflicting action/operation before creating a preview or calling Gmail",async()=>{
   mocks.getAccount.mockResolvedValue({id:"44444444-4444-4444-8444-444444444444",generation:4,email:"owner@example.com"});
   await expect(gmailCapability.simulate(scope,{...input,operation:"trash",action:"archive",messageId:"message12345"}))
     .rejects.toThrow("gmail_action_operation_mismatch");
   await expect(gmailCapability.simulate(scope,{...input,operation:"send",action:"mark_read"}))
     .rejects.toThrow("gmail_action_operation_mismatch");
   expect(mocks.getAccount).not.toHaveBeenCalled();
   expect(mocks.send).not.toHaveBeenCalled();
 });
 it("refuses to propose if account is absent",async()=>{
   mocks.getAccount.mockResolvedValue(null);
   await expect(gmailCapability.simulate(scope,input)).rejects.toThrow("gmail_not_authorized");
 });
 it("refuses effectful commit without a gateway-provided proposal ID",async()=>{
   await expect(gmailCapability.commit(scope,{...input,accountId:"44444444-4444-4444-8444-444444444444",generation:1,from:"owner@example.com"},undefined)).rejects.toThrow("gmail_proposal_id_required");
   expect(mocks.send).not.toHaveBeenCalled();
 });
});
