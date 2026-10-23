import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
const migration=readFileSync(resolve("supabase/migrations/20261023000088_staff_approval_prep_delivery.sql"),"utf8");
describe("staff owner-send SQL invariants",()=>{
 it("does not grant the browser the ability to forge sent receipts",()=>{
  expect(migration).toMatch(/staff_mark_owner_delivery/);
  expect(migration).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  expect(migration).toMatch(/status='committed'/);
  expect(migration).toMatch(/status IN \('approved','published'\)/);
  expect(migration).toMatch(/whatsapp_opt_in IS NOT TRUE/);
  expect(migration).toMatch(/sent_by=p_owner_user_id/);
  expect(migration).toMatch(/status='sent_by_owner'/);
  expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.staff_mark_owner_delivery/);
  expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.staff_mark_owner_delivery[\s\S]*TO service_role/);
 });
 it("requires a single approved source and keeps owner records tenant-scoped",()=>{
  expect(migration).toMatch(/CHECK \(\(proposal_id IS NULL\) <> \(plan_revision_id IS NULL\)\)/);
  expect(migration).toMatch(/business_id=p_business_id\s+AND id=p_employee_id/);
  expect(migration).toMatch(/preferred_schedule_channel/);
 });
 it("freezes a whole-week snapshot and checks the exact same source on every tap",()=>{
   expect(migration).toMatch(/staff_schedule_handoff_snapshots/);
   expect(migration).toMatch(/INSERT INTO public.staff_schedule_handoff_snapshots/);
   expect(migration).toMatch(/v_snapshot.shifts IS DISTINCT FROM public.staff_handoff_week_shifts/);
   expect(migration).not.toMatch(/s.updated_at <= v_proposal.committed_at/);
 });
 it("checks adjacent overlap inside the atomic commit and stamps validated owner context",()=>{
   expect(migration).toMatch(/PERFORM set_config\('request.jwt.claim.sub',p_owner_user_id::text,true\)/);
   expect(migration).toMatch(/tsrange\(a.local_date\+a.start_local/);
   expect(migration).toMatch(/overlapping_staff_shifts/);
 });
});
});
