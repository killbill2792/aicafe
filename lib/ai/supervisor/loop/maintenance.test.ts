import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {singleMailbox,maintenanceAssignmentInput,maintenanceContext} from "./maintenance.server";
const caseId="maintenance:10000000-0000-4000-8000-000000000001";
const employeeId="10000000-0000-4000-8000-000000000002";
describe("maintenance exact-source approval boundary",()=>{
 it("rejects ambiguous or injected mailbox headers",()=>{
  expect(singleMailbox("Repair Team <REPAIR@example.invalid>")).toBe("repair@example.invalid");
  for(const bad of ["a@example.invalid,b@example.invalid","a@example.invalid; b@example.invalid","Repair <a@example.invalid>\nBcc: b@example.invalid","Repair <bad>","a@example.invalid, B <b@example.invalid>"])
   expect(singleMailbox(bad)).toBeNull();
 });
 it("rejects an invented permission or unsupported action",()=>{
  const input={maintenanceCaseId:caseId,employeeId,prompt:"Check equipment",purpose:"verify_working",dueAt:null};
  expect(maintenanceAssignmentInput.safeParse(input).success).toBe(true);
  expect(maintenanceAssignmentInput.safeParse({...input,approved:true}).success).toBe(false);
  expect(maintenanceAssignmentInput.safeParse({...input,purpose:"close"}).success).toBe(false);
 });
 it("does not let a worker select a different case or an owner turn register repair evidence",async()=>{
  const from=vi.fn();const db={from} as unknown as SupabaseClient;
  const scope={businessId:employeeId,ownerUserId:employeeId,threadId:employeeId,locale:"en" as const};
  const leased=maintenanceContext(db,scope,{lease:{caseId,token:employeeId,revisionHash:"a".repeat(64)}});
  await expect(leased.staff("maintenance:"+employeeId)).rejects.toThrow("maintenance_case_scope_mismatch");
  await expect(maintenanceContext(db,scope,{}).recordRepairClaim(caseId,employeeId)).rejects.toThrow("maintenance_worker_only");
  expect(from).not.toHaveBeenCalled();
 });
});
