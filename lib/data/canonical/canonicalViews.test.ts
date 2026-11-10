import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
// The old diagnostic projection still exists in historical migrations. Assertions
// must examine the FINAL replacement definition, not the obsolete migration-114 view.
const sql=readFileSync(resolve(
 "supabase/migrations/20261109000156_pos0e_shared_current_reader.sql"),"utf8");
const historic=readFileSync(resolve(
 "supabase/migrations/20261028000114_toast_optional_canonical_views.sql"),"utf8");
const view=(name:string)=>sql.split("create or replace view public."+name)[1]
 ?.split("create or replace view public.")[0]?.split("revoke all on public.")[0]??"";
describe("POS0e current-source optional canonical SQL contracts",()=>{
 it("preserves order channel/guest projections from the older independently owned view",()=>{
  const orders=historic.split("create or replace view public.cv_orders")[1]
   ?.split("create or replace view public.")[0]??"";
  expect(orders).toContain("o.dining_option");
  expect(orders).toContain("o.source_channel");
  expect(orders).toContain("o.guest_count");
 });
 it("reads operational stock and pantry with null-preserving quantities",()=>{
  const x=view("cv_inventory");
  expect(x).toContain("pantry_stock_counts");
  expect(x).toContain("stock/v1/inventory");
  expect(x).toContain("then (r.data->>'quantity')::numeric else null::numeric");
 });
 it("preserves cash/deposit identities and kitchen prep/timing facts",()=>{
  for(const entity of ["cashmgmt/v1/entries","cashmgmt/v1/deposits"])
   expect(view("cv_cash")).toContain(entity);
  for(const field of ["ticketFiredAt","itemStartedAt","itemFulfilledAt",
   "prepStationGuid","prepStationName"])
   expect(view("cv_kitchen")).toContain(field);
  expect(view("cv_dining_options")).toContain("config/v2/diningOptions");
 });
 it("forbids diagnostic capture through any active canonical view or source reader",()=>{
  for(const name of ["cv_inventory","cv_cash","cv_kitchen","cv_dining_options"]){
   const definition=view(name);
   expect(definition,name).toContain("toast_records_for(null,null,null)");
   expect(definition,name).toContain("security_invoker=true");
   expect(definition,name).not.toMatch(/toast_raw_samples(?:_latest)?/);
  }
  const reader=sql.split("create or replace function public.toast_records_for")[1]
   ?.split("revoke all on function public.toast_records_for")[0]??"";
  expect(reader).toContain("from public.toast_raw_records");
  expect(reader).not.toContain("toast_raw_samples");
  expect(reader).toContain("public.toast_records_allowed");
 });
 it("does not add a second importer or reader, fake zero or widen table grants",()=>{
  expect(sql).not.toMatch(/(?:create|alter)\s+table\s+public\.toast_raw_/i);
  expect(sql).not.toContain("grant select on public.toast_raw_records");
  expect(sql).not.toMatch(/coalesce\(.*quantity.*0/i);
  expect(sql).toContain("count");
 });
});
