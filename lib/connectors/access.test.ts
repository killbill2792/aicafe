import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/connectors/registry.server",()=>({
  assertConnectorOwnerLive:vi.fn(async()=>undefined),
}));
const test=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
 from:test.from,rpc:test.rpc,
})}));
import {externalAccess,assertExternalAccess,assertSelectedAttachmentAccess,
 changeExternalAccess,WEB_RESOURCE,FILE_RESOURCE} from "./access.server";
const owner={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const file="33333333-3333-4333-8333-333333333333";
beforeEach(()=>{vi.clearAllMocks();});
const reader=(rows:Record<string,unknown>)=>{
 test.from.mockImplementation((table:string)=>{
  expect(table).toBe("supervisor_external_access");
  const filters=new Map<string,string>();
  const q={select:vi.fn(()=>q),eq:vi.fn((column:string,value:string)=>{
   filters.set(column,value);return q;}),
   maybeSingle:vi.fn(async()=>{
    const key=filters.get("kind")+":"+filters.get("resource_key");
    return {data:rows[key]??null,error:null};
   })};
  return q;
 });
};
describe("one café-scoped Supervisor external access gate",()=>{
 it("preserves existing public-only research and explicit file-selection defaults",async()=>{
  reader({});
  await expect(externalAccess(owner,"public_web",WEB_RESOURCE))
   .resolves.toEqual({allowed:true,revision:0});
  await expect(assertSelectedAttachmentAccess(owner,file)).resolves.toBeUndefined();
  expect(test.from).toHaveBeenCalledTimes(3);
 });
 it("denies a revoked single file even if general file use is allowed",async()=>{
  reader({["attachment:"+file]:{allowed:false,revision:5}});
  await expect(assertSelectedAttachmentAccess(owner,file))
   .rejects.toThrow("attachment_access_revoked");
  expect(test.from).toHaveBeenCalledTimes(2);
 });
 it("denies all files when owner pauses them, before checking any individual file",async()=>{
  reader({"file_read:all":{allowed:false,revision:1}});
  await expect(assertSelectedAttachmentAccess(owner,file))
   .rejects.toThrow("file_read_access_revoked");
  expect(test.from).toHaveBeenCalledTimes(1);
 });
 it("fails closed when the permission database is unavailable",async()=>{
  test.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,
   maybeSingle:async()=>({data:null,error:{message:"network"}})};return q;});
  await expect(assertExternalAccess(owner,"public_web",WEB_RESOURCE))
   .rejects.toThrow("external_access_unavailable");
 });
 it("never uses a model-supplied café or allows re-enabling a revoked attachment",async()=>{
  test.rpc.mockResolvedValue({data:{allowed:false,revision:1},error:null});
  await expect(changeExternalAccess(owner,"attachment",file,true,0))
   .rejects.toThrow("external_access_input_invalid");
  expect(test.rpc).not.toHaveBeenCalled();
  await expect(changeExternalAccess(owner,"attachment",file,false,0))
   .resolves.toEqual({allowed:false,revision:1});
  expect(test.rpc).toHaveBeenCalledWith("supervisor_change_external_access",{
   p_business_id:owner.businessId,p_owner_user_id:owner.ownerUserId,
   p_kind:"attachment",p_resource_key:file,p_allowed:false,p_expected_revision:0,
  });
 });
 it("canonicalizes mixed-case UUIDs on both permission writes and reads",async()=>{
  reader({["attachment:"+file]:{allowed:false,revision:7}});
  await expect(assertSelectedAttachmentAccess(owner,file.toUpperCase()))
   .rejects.toThrow("attachment_access_revoked");
  expect(test.from).toHaveBeenCalledTimes(2);
  test.rpc.mockResolvedValue({data:{allowed:false,revision:8},error:null});
  await expect(changeExternalAccess(owner,"attachment",file.toUpperCase(),false,7))
   .resolves.toEqual({allowed:false,revision:8});
  expect(test.rpc).toHaveBeenCalledWith("supervisor_change_external_access",
    expect.objectContaining({p_kind:"attachment",p_resource_key:file,p_expected_revision:7}));
 });
 it("treats stale or uncertain permission writes as failures, not granted access",async()=>{
  test.rpc.mockResolvedValueOnce({data:null,error:{code:"40001"}})
    .mockResolvedValueOnce({data:null,error:{code:"P0001"}});
  await expect(changeExternalAccess(owner,"public_web","public",false,0))
   .rejects.toThrow("external_access_stale");
  await expect(changeExternalAccess(owner,"file_read",FILE_RESOURCE,false,0))
   .rejects.toThrow("external_access_change_failed");
 });
});
