import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
const sql=readFileSync(resolve("supabase/migrations/20261028000114_toast_optional_canonical_views.sql"),"utf8");
const view=(name:string)=>sql.split("create or replace view public."+name)[1]?.split("create or replace view public.")[0]??"";
describe("Toast optional canonical SQL contracts",()=>{
 it("preparation station configuration GUID and name are not silently omitted",()=>{
  const recent=readFileSync(resolve("supabase/migrations/20261028000118_toast_kitchen_prep_station.sql"),"utf8");
  expect(recent).toContain("coalesce(x.item->>'prepStationGuid',x.item->>'guid')");
  expect(recent).toContain("coalesce(x.item->>'prepStationName',x.item->>'name')");
  expect(recent).toContain("public.toast_safe_business_label");
 });
 it("keeps dining option, channel and guest count on the order projection",()=>{
  expect(view("cv_orders")).toMatch(/o\.dining_option/);
  expect(view("cv_orders")).toMatch(/o\.source_channel/);
  expect(view("cv_orders")).toMatch(/o\.guest_count/);
 });
 it("joins Toast stock statuses alongside app pantry counts without zero-filling unknowns",()=>{
  const x=view("cv_inventory");
  expect(x).toContain("pantry_stock_counts");
  expect(x).toContain("stock/v1/inventory");
  expect(x).toContain("'toast'::text");
  expect(x).toContain("else null::numeric");
 });
 it("exposes cash, deposits and kitchen times only from successful redacted samples",()=>{
  expect(view("cv_cash")).toContain("cashmgmt/v1/entries");
  expect(view("cv_cash")).toContain("cashmgmt/v1/deposits");
  for(const name of ["cv_cash","cv_kitchen","cv_dining_options"])
   expect(view(name)).toContain("s.error_code is null");
  for(const field of ["ticketFiredAt","itemStartedAt","itemFulfilledAt"])
   expect(view("cv_kitchen")).toContain(field);
  expect(view("cv_dining_options")).toContain("config/v2/diningOptions");
 });
 it("uses café-local stock/config capture dates, invoker RLS, no whole raw sample projection",()=>{
  expect(view("cv_inventory")).toContain("at time zone b.timezone");
  for(const name of ["cv_orders","cv_inventory","cv_cash","cv_kitchen","cv_dining_options"])
   expect(view(name)).toContain("security_invoker=true");
  expect(sql).not.toMatch(/select\s+(?:s\.)?sample\b/i);
  for(const name of ["cv_orders","cv_cash","cv_kitchen","cv_dining_options"])
   expect(sql).toContain("'"+name+"'");
 });
});
