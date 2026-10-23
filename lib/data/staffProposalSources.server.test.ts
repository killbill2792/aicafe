import {beforeEach,describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({owner:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/scheduling/foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
import {readStaffProposalSources,readStaffProposalToken} from "./staffProposalSources.server";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const scope={businessId:"tenant-1",ownerUserId:"person-1"};
describe("owner-scoped staff proposal data boundary",()=>{
 beforeEach(()=>vi.clearAllMocks());
 it("cannot read service-role data without owner authentication",async()=>{
  mocks.owner.mockResolvedValue(null);
  await expect(readStaffProposalSources(scope,null,null)).rejects.toThrow(/owner/);
  await expect(readStaffProposalToken(scope)).rejects.toThrow(/owner/);
  expect(mocks.admin).not.toHaveBeenCalled();
 });
 it("rejects wrong cafe or different authenticated actor before privileged reads",async()=>{
  mocks.owner.mockResolvedValue({businessId:"tenant-2",
   supabase:{auth:{getUser:vi.fn().mockResolvedValue({data:{user:{id:"person-1"}},error:null})}}});
  await expect(readStaffProposalSources(scope,null,null)).rejects.toThrow();
  expect(mocks.admin).not.toHaveBeenCalled();
  mocks.owner.mockResolvedValue({businessId:"tenant-1",
   supabase:{auth:{getUser:vi.fn().mockResolvedValue({data:{user:{id:"other"}},error:null})}}});
  await expect(readStaffProposalToken(scope)).rejects.toThrow(/session/);
  expect(mocks.admin).not.toHaveBeenCalled();
 });
 it("runs source CAS token only for the authenticated tenant",async()=>{
  mocks.owner.mockResolvedValue({businessId:"tenant-1",
   supabase:{auth:{getUser:vi.fn().mockResolvedValue({data:{user:{id:"person-1"}},error:null})}}});
  const rpc=vi.fn().mockResolvedValue({data:"a".repeat(32),error:null});
  mocks.admin.mockReturnValue({rpc});
  expect(await readStaffProposalToken(scope)).toBe("a".repeat(32));
  expect(rpc).toHaveBeenCalledWith("supervisor_staff_source_token",{p_business_id:"tenant-1"});
 });
 it("keeps all privileged reads out of the AI capability and labels absence types",()=>{
  const source=readFileSync(resolve("lib/ai/supervisor/loop/staffProposals.server.ts"),"utf8");
  expect(source).not.toContain("createAdminSupabaseClient");
  expect(source).not.toMatch(/\.from\(|\.rpc\(/);
  expect(source).not.toContain("x.local_date+\" \"+x.exception_type");
  for(const catalog of [en,es,ar]){
   const copy=catalog.StaffApprovalCard;
   for(const label of ["exceptionUnavailable","exceptionApprovedLeave","exceptionReplaceDay",
    "exceptionAddAvailable","exceptionHoursCap","exceptionOther","ruleFallback"] as const)
    expect(copy[label].trim().length).toBeGreaterThan(0);
  }
 });
});
