import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const ownerRead=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/staffCoordination/cases.server",()=>({
 listOwnerStaffCoordination:ownerRead,
}));
import {staffCoordinationTools} from "./staffCoordination";
import type {AgentToolContext} from "./index";

const caseRow={
 id:"11111111-1111-4111-8111-111111111111",
 source_kind:"staff_message",source_key:"secret-message-ref",
 case_kind:"intake",employee_id:"22222222-2222-4222-8222-222222222222",
 location_id:null,role_needed:null,from_date:null,to_date:null,
 state:"new",decision:null,revision:1,next_check_at:"2026-11-17T18:00:00Z",
 retention_at:null,created_at:"2026-11-17T08:00:00Z",
 updated_at:"2026-11-17T08:00:00Z",
};
const base={
 timezone:"America/Los_Angeles",locale:"en",asOf:"2026-11-17",
 tools:{},
} as unknown as AgentToolContext;
describe("13D registered Supervisor evidence tool",()=>{
 beforeEach(()=>ownerRead.mockReset());
 it("uses SQL-claimed owner/café scope in an unattended investigation, not cookies",async()=>{
  const scoped=vi.fn(async()=>[caseRow]);
  const ctx={...base,investigation:{read:vi.fn(),weekSchedule:vi.fn()},
   staffCoordinationRead:scoped} as unknown as AgentToolContext;
  const result=await staffCoordinationTools.get_staff_coordination_cases.execute({},ctx);
  expect(scoped).toHaveBeenCalledTimes(1);
  expect(ownerRead).not.toHaveBeenCalled();
  expect(result).toMatchObject({
   source:"staff_coordination_cases",missing:[],
   cases:[{id:caseRow.id,kind:"intake",sourceKind:"staff_message",
    ownerDecision:null,effectApplied:false}],
  });
  expect(JSON.stringify(result)).not.toContain(caseRow.source_key);
 });
 it("never falls back to a session owner when the claimed off-turn reader is missing",async()=>{
  const ctx={...base,investigation:{read:vi.fn(),weekSchedule:vi.fn()}}
   as unknown as AgentToolContext;
  const result=await staffCoordinationTools.get_staff_coordination_cases.execute({},ctx);
  expect(result.missing).toContain("staffCoordinationClaimedReaderUnavailable");
  expect(ownerRead).not.toHaveBeenCalled();
 });
 it("rejects model-selected case or café IDs as strict-schema violations",async()=>{
  await expect(staffCoordinationTools.get_staff_coordination_cases.execute({
   business_id:"foreign-tenant",case_id:caseRow.id,
  },base)).rejects.toThrow();
  expect(ownerRead).not.toHaveBeenCalled();
 });
 it("uses the authenticated owner source for direct chat, and fails closed on errors",async()=>{
  ownerRead.mockResolvedValueOnce([caseRow]).mockRejectedValueOnce(new Error("unauthorized"));
  const first=await staffCoordinationTools.get_staff_coordination_cases.execute({},base);
  expect(first.missing).toEqual([]);
  const second=await staffCoordinationTools.get_staff_coordination_cases.execute({},base);
  expect(second.missing).toContain("staffCoordinationReadFailed");
 });
});
