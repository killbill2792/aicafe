import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
describe("Toast promotion keeps source and coverage safety barriers",()=>{
 const sql=readFileSync("supabase/migrations/20261012000048_toast_promotion_safety.sql","utf8");
 it("prevents refund-day misattribution before allowing manual canonical writes",()=>{
  expect(sql).toContain("staged.refunds_cents<>0");
  expect(sql).toContain("toast_promote_reconciled_day_legacy");
 });
 it("refuses multi-location partial coverage and zero-sales promotion",()=>{
  expect(sql).toContain("count(*) FROM locations");
  expect(sql).toContain("staged.order_count=0");
  expect(sql).toContain("FOR UPDATE");
 });
 it("does not grant direct client execution of the privileged RPC",()=>{
  expect(sql).toContain("FROM PUBLIC,anon,authenticated");
  expect(sql).toContain("TO service_role");
 });
});
