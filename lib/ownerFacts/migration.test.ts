import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../../supabase/migrations/20261028000110_owner_facts.sql",import.meta.url),"utf8");
describe("owner facts migration static safety checks",()=>{
 it("uses matching PostgreSQL PL/pgSQL dollar-quoted function bodies",()=>{
  expect(sql.match(/language plpgsql security definer set search_path\s*=\s*public as \$\$/gi)).toHaveLength(2);
  expect(sql.match(/end \$\$;/gi)).toHaveLength(2);
  expect(sql).not.toMatch(/\bas \$(?!\$)/i);
 });
 it("reconciles owner total bills to itemized costs without deleting source records",()=>{
  expect(sql).toContain("v_remainder := v_amount-v_other_monthly;");
  expect(sql).toContain("if v_amount >= v_other_monthly then");
  expect(sql).toContain("rc.active_from<=v_day");
  expect(sql).toContain("not (rc.source='owner' and rc.label='Owner reported monthly bills')");
  expect(sql).not.toMatch(/delete from public\.recurring_costs/i);
 });
 it("retries incomplete write-through without superseding an identical saved answer",()=>{
  expect(sql).toContain("if coalesce(v_written,false) then");
  expect(sql).toContain("if v_id is null then");
  expect(sql).toContain("Same saved answer, but a previously incomplete screen write-through");
 });
 it("keeps owner facts tenant scoped and private",()=>{
  expect(sql).toContain("alter table public.owner_facts enable row level security;");
  expect(sql).toContain("m.business_id=p_business_id");
  expect(sql).toContain("m.user_id=v_uid");
  expect(sql).toContain("revoke insert, update, delete on public.owner_facts from authenticated;");
 });
});
