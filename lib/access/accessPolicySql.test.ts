import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../../supabase/migrations/20261023000090_free_access_codes.sql",import.meta.url),"utf8");
describe("free access SQL security contract",()=>{
 it("prevents a code from undoing an administrator pause",()=>{
  expect(sql).toMatch(/select \* into v_access from public\.cafe_access where business_id=p_business_id for update;/);
  expect(sql).toContain("if v_access.mode = 'paused' then");
  expect(sql).toContain("if v_access.mode='paused' then return");
 });
 it("does not convert a grandfathered cafe into a timed grant",()=>{
  expect(sql).toMatch(/if v_access.mode <> 'grandfathered' then\s+update public\.cafe_access/);
 });
 it("uses local civil dates in redemption and admin extensions",()=>{
  expect(sql).toContain("v_today := (now() at time zone v_timezone)::date");
  expect(sql).toContain("p_access_end < (now() at time zone v_timezone)::date");
 });
 it("serializes capacity and counts beyond page limits",()=>{
  expect(sql).toContain("where code_hash=p_code_hash and active=true for update");
  expect(sql).toContain("if v_used>=v_code.max_cafes then");
  expect(sql).toContain("admin_code_redemption_counts()");
  expect(sql).toContain("from public.free_access_redemptions group by code_id");
  expect(sql).toContain("grant execute on function public.admin_code_redemption_counts() to service_role");
 });
});
