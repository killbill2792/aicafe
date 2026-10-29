import {describe,it,expect} from "vitest";
import {compareDayMoney} from "./dayCheck";
const totals={net_sales_cents:15000,discounts_cents:500,refunds_cents:120,
 tax_cents:895,tip_cents:2000};
describe("single Toast money check",()=>{
 it("does not flag a changed checksum with equal money",()=>{
  const result=compareDayMoney(totals,{...totals});
  expect(result.needsLook).toBe(false);
  expect(result.matched).toBe(true);
  expect(result.toastNetSalesCents).toBe(15000);
 });
 it("flags a two-cent mismatch with its field and signed cents",()=>{
  const result=compareDayMoney(totals,{...totals,net_sales_cents:15002});
  expect(result.needsLook).toBe(true);
  expect(result.reasons).toContain("net_sales_cents_delta_2_cents");
 });
 it("missing totals are explicit but not fabricated as zero or mismatch",()=>{
  const result=compareDayMoney(totals,{net_sales_cents:15000});
  expect(result.needsLook).toBe(false);
  expect(result.matched).toBe(false);
  expect(result.missing).toContain("tax_cents");
 });
 it("one cent within tolerance does not trigger needs-a-look",()=>{
  expect(compareDayMoney(totals,{...totals,discounts_cents:501}).needsLook).toBe(false);
 });
});
