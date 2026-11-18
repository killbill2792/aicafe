import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const deps=vi.hoisted(()=>({owner:vi.fn(),state:vi.fn(),change:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/connectors/registry.server",()=>({requireConnectorOwner:deps.owner}));
vi.mock("@/lib/connectors/access.server",()=>({
 externalAccess:deps.state,changeExternalAccess:deps.change,
 WEB_RESOURCE:"public",FILE_RESOURCE:"all",
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:deps.from})}));
import {GET,POST} from "./route";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const url="http://localhost:3000/api/supervisor/access";
const request=(body:unknown,origin="http://localhost:3000")=>new Request(url,{
 method:"POST",headers:{"origin":origin,"content-type":"application/json"},
 body:JSON.stringify(body)});
beforeEach(()=>{
 vi.clearAllMocks();deps.owner.mockResolvedValue(scope);
 deps.state.mockResolvedValue({allowed:true,revision:0});
 deps.change.mockResolvedValue({allowed:false,revision:1});
 deps.from.mockImplementation((table:string)=>{
  const q={select:vi.fn(()=>q),eq:vi.fn(()=>q),order:vi.fn(()=>q),
   in:vi.fn(async()=>({data:[],error:null})),
   range:vi.fn(async()=>({data:[],error:null}))};
  return q;
 });
});
describe("Task16C owner-permission HTTP boundary",()=>{
 it("rejects foreign origins and unauthenticated owners before touching data",async()=>{
  expect((await POST(request({kind:"public_web",enabled:false,revision:0},
    "https://outside.invalid"))).status).toBe(403);
  expect(deps.owner).not.toHaveBeenCalled();
  deps.owner.mockRejectedValue(new Error("owner_required"));
  expect((await GET(new Request(url))).status).toBe(403);
  expect((await POST(request({kind:"public_web",enabled:false,revision:0}))).status).toBe(403);
  expect(deps.change).not.toHaveBeenCalled();
 });
 it("returns only scoped file metadata and access state, not any object storage keys",async()=>{
  const result=await GET(new Request(url));
  expect(result.status).toBe(200);
  const value=await result.json();
  expect(value).toMatchObject({publicWeb:{allowed:true,revision:0},
    fileRead:{allowed:true,revision:0},files:[],
    computer:{available:false,connected:false}});
  expect(JSON.stringify(value)).not.toContain("object_path");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(deps.from).toHaveBeenCalledWith("ai_attachments");
 });
 it("updates one owner-scoped access key, not a caller-chosen café",async()=>{
  const response=await POST(request({kind:"public_web",enabled:false,revision:0}));
  expect(response.status).toBe(200);
  expect(deps.change).toHaveBeenCalledWith(scope,"public_web","public",false,0);
  expect(await response.json()).toMatchObject({allowed:false,revision:1});
 });
 it("never turns an old file back on",async()=>{
  const file="33333333-3333-4333-8333-333333333333";
  expect((await POST(request({kind:"attachment",attachmentId:file,
    enabled:true,revision:1}))).status).toBe(422);
  expect(deps.change).not.toHaveBeenCalled();
 });
 it("reports stale and uncertain writes rather than claiming success",async()=>{
  deps.change.mockRejectedValueOnce(new Error("external_access_stale"))
   .mockRejectedValueOnce(new Error("external_access_change_failed"));
  const body={kind:"file_read",enabled:false,revision:0};
  expect((await POST(request(body))).status).toBe(409);
  const uncertain=await POST(request(body));
  expect(uncertain.status).toBe(503);
  expect(await uncertain.json()).toMatchObject({error:"access_change_unverified"});
 });
});
