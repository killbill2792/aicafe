import {describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
vi.mock("server-only",()=>({}));
import {rebuildSalesFactRollups} from "./salesFactRollups";
import type {SupabaseClient} from "@supabase/supabase-js";
describe("atomic POS sales fact rebuilding",()=>{
 it("uses a transactional database RPC once per affected date, never client-side deletes",async()=>{
  const rpc=vi.fn(async (_name:string,_args:Record<string,unknown>)=>({error:null}));
  const db={rpc,from:()=>{throw Error("nontransactional table mutation")}} as unknown as SupabaseClient;
  await rebuildSalesFactRollups(db,"business",["2026-08-23","2026-08-22","2026-08-22"],"America/Los_Angeles");
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls.map(call=>call[0])).toEqual(["pos_rebuild_sales_fact_rollups_v1","pos_rebuild_sales_fact_rollups_v1"]);
  expect(rpc.mock.calls.map(call=>call[1])).toEqual([
   {p_business_id:"business",p_business_date:"2026-08-22"},
   {p_business_id:"business",p_business_date:"2026-08-23"}]);
 });
 it("propagates failed RPCs without deleting prior facts or continuing",async()=>{
  const rpc=vi.fn(async()=>({error:new Error("database declined")}));
  await expect(rebuildSalesFactRollups({rpc} as unknown as SupabaseClient,"b",["2026-08-22"],"UTC"))
   .rejects.toThrow("database declined");
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("the migration implements locked SQL-side aggregation inside one transaction",()=>{
  const sql=readFileSync(new URL("../../supabase/migrations/20261023000084_pos_fact_enrichment.sql",import.meta.url),"utf8");
  expect(sql).toContain("pg_advisory_xact_lock");
  expect(sql).toContain("sum(o.net_sales_cents)");
  expect(sql).toContain("security invoker");
  // Canonical payroll and employee sales are owner-scoped, not writable by
  // arbitrary café members. Service-role ingestion continues to bypass RLS.
  expect(sql).toContain('create policy "owners read"');
  expect(sql).toContain('create policy "owners write"');
  expect(sql).toContain('public.scheduling_is_owner(business_id)');
  expect(sql).toContain('not public.scheduling_is_owner(p_business_id)');
  expect(sql).toContain("pos_order_id not like 'csv-%'");
 });
});