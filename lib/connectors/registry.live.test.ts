import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const deps=vi.hoisted(()=>({from:vi.fn(),membership:vi.fn(),account:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:deps.from})}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn()}));
import {assertConnectorOwnerLive,getConnectorAccount} from "./registry.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
beforeEach(()=>{
 vi.clearAllMocks();deps.membership.mockResolvedValue({data:{role:"owner"},error:null});
 deps.account.mockResolvedValue({data:{id:"33333333-3333-4333-8333-333333333333",
   business_id:scope.businessId,owner_user_id:scope.ownerUserId,provider:"gmail",
   provider_subject:"sub",email:"owner@example.invalid",
   granted_scopes:["https://www.googleapis.com/auth/gmail.modify"],
   enabled_operations:["read"],status:"active",generation:1},error:null});
 deps.from.mockImplementation((table:string)=>{
  const q={select:()=>q,eq:()=>q,maybeSingle:()=>table==="memberships"?
    deps.membership():deps.account()};
  return q;
 });
});
describe("revoked owner membership is not a reusable saved connector authority",()=>{
 it("requires current owner membership even with an old valid account and worker scope",async()=>{
  deps.membership.mockResolvedValue({data:{role:"staff"},error:null});
  await expect(assertConnectorOwnerLive(scope)).rejects.toThrow("connector_owner_access_revoked");
  await expect(getConnectorAccount(scope)).rejects.toThrow("connector_owner_access_revoked");
  expect(deps.account).not.toHaveBeenCalled();
 });
 it("reads the same owner and café only after proving live authorization",async()=>{
  const account=await getConnectorAccount(scope);
  expect(account).toMatchObject({businessId:scope.businessId,ownerUserId:scope.ownerUserId,
    email:"owner@example.invalid",enabled_operations:["read"]});
  expect(deps.from).toHaveBeenCalledWith("memberships");
  expect(deps.from).toHaveBeenCalledWith("connector_accounts");
 });
 it("does not trust an unexpectedly cross-café account returned from storage",async()=>{
  deps.account.mockResolvedValue({data:{id:"33333333-3333-4333-8333-333333333333",
    business_id:"44444444-4444-4444-8444-444444444444",owner_user_id:scope.ownerUserId,
    provider:"gmail",granted_scopes:[],enabled_operations:[],generation:1},error:null});
  await expect(getConnectorAccount(scope)).rejects.toThrow("connector_scope_mismatch");
 });
});
