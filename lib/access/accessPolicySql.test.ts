import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../../supabase/migrations/20261023000090_free_access_codes.sql",import.meta.url),"utf8");
describe("free access SQL security contract",()=>{
 it("has non-duplicated, completed SQL functions",()=>{
   const functions=[...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(m=>m[1]);
   expect(functions).toHaveLength(5);
   expect(new Set(functions).size).toBe(5);
   expect((sql.match(/\$\$/g)??[])).toHaveLength(8);
   expect((sql.match(/\$cafe_init\$/g)??[])).toHaveLength(2);
   expect(sql).toContain("if p_code_hash !~ '^[a-f0-9]{64}$' or p_business_id is null");
   expect(sql).not.toMatch(/end \$\$;[\s\S]*\n or p_business_id is null/);
 });
 it("restores the shared demo after the trusted destructive database reseed",()=>{
   const reset=readFileSync(new URL("../../scripts/db-reset.mjs",import.meta.url),"utf8");
   const businessInsert=reset.indexOf('await insertRows(client, "businesses"');
   const demoOverride=reset.indexOf("insert into public.cafe_access");
   expect(businessInsert).toBeGreaterThan(-1);
   expect(demoOverride).toBeGreaterThan(businessInsert);
   expect(reset.slice(demoOverride)).toContain("mode = 'grandfathered'");
   expect(reset.slice(demoOverride)).toContain("code_id = null, access_end = null");
   expect(reset.slice(demoOverride)).toContain("[DEMO_BUSINESS_ID]");
 });
 it("grandfathers existing cafes but expires new cafes until code redemption",()=>{
   expect(sql.indexOf("select id,'grandfathered'")).toBeLessThan(sql.indexOf("create trigger initialize_cafe_access"));
   expect(sql).toContain("(now() at time zone coalesce(nullif(new.timezone,''),'UTC'))::date - 1");
   expect(sql).toContain("return jsonb_build_object('status','already_redeemed')");
 });
 it("prevents direct authenticated Supabase rule approval after expiry",()=>{
   expect(sql).toContain("before insert or update on public.ai_team_rules");
   expect(sql).toContain("v_mode='paused'");
   expect(sql).toContain("v_end<v_today");
 });
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
