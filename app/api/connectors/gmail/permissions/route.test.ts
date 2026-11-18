import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const deps=vi.hoisted(()=>({owner:vi.fn(),account:vi.fn(),rpc:vi.fn()}));
vi.mock("@/lib/connectors/registry.server",()=>({
 requireConnectorOwner:deps.owner,getConnectorAccount:deps.account,
 connectorOperations:["read","draft","send","organize"],
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({rpc:deps.rpc})}));
import {PATCH} from "./route";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const account={id:"33333333-3333-4333-8333-333333333333",...scope,
 provider:"gmail",status:"active",generation:4};
const url="http://localhost:3000/api/connectors/gmail/permissions";
const request=(body:unknown,origin="http://localhost:3000")=>new Request(url,{method:"PATCH",
 headers:{"origin":origin,"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{
 vi.clearAllMocks();
 deps.owner.mockResolvedValue(scope);deps.account.mockResolvedValue(account);
 deps.rpc.mockResolvedValue({data:{generation:5,operations:["read","draft"]},error:null});
});
describe("Gmail permission switches are owner and account scoped",()=>{
 it("rejects forged cross-origin request before any permission or provider access",async()=>{
  const response=await PATCH(request({accountId:account.id,generation:4,operations:["read"]},"https://attacker.invalid"));
  expect(response.status).toBe(403);
  expect(deps.owner).not.toHaveBeenCalled();
  expect(deps.rpc).not.toHaveBeenCalled();
 });
 it("uses the current account ID and revision, not a model-supplied café",async()=>{
  const response=await PATCH(request({accountId:account.id,generation:4,operations:["read","draft"]}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({generation:5,enabledOperations:["read","draft"]});
  expect(deps.rpc).toHaveBeenCalledWith("supervisor_change_gmail_operations",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
   p_account_id:account.id,p_expected_generation:4,p_operations:["read","draft"],
  });
 });
 it("refuses stale, disconnected and other-account permissions without a write",async()=>{
  for(const input of [
    {accountId:account.id,generation:3,operations:["read"]},
    {accountId:"44444444-4444-4444-8444-444444444444",generation:4,operations:["read"]},
  ]){
   const res=await PATCH(request(input));expect(res.status).toBe(409);
  }
  deps.account.mockResolvedValue({...account,status:"revoking"});
  expect((await PATCH(request({accountId:account.id,generation:4,operations:["send"]}))).status).toBe(409);
  expect(deps.rpc).not.toHaveBeenCalled();
 });
 it("rejects duplicate or unknown operations instead of granting a larger Google scope",async()=>{
  for(const operations of [["send","send"],["read","delete_anything"]]){
   const res=await PATCH(request({accountId:account.id,generation:4,operations}));
   expect(res.status).toBe(403);
  }
  expect(deps.rpc).not.toHaveBeenCalled();
 });
 it("keeps a failed or uncertain save visible rather than claiming permission changed",async()=>{
  deps.rpc.mockResolvedValue({data:null,error:{code:"40001"}});
  const result=await PATCH(request({accountId:account.id,generation:4,operations:["read"]}));
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({error:"connection_changed_refresh"});
 });
});
