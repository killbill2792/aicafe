import {describe,it,expect} from "vitest";
import {applicableLocations,dayTotals,dayCoverage} from "./ownerCoverage";
const north={restaurant_guid:"north",verified_at:"2026-10-01",toast_start_date:"2026-10-01"};
const south={restaurant_guid:"south",verified_at:"2026-10-13",toast_start_date:"2026-10-10"};
const old={business_date:"2026-10-05",restaurant_guid:"north",import_state:"imported",
 coverage_complete:true,net_sales_cents:12345,order_count:4,recon_state:"matched"};
const later={...old,business_date:"2026-10-12",net_sales_cents:10000};
const southLater={...later,restaurant_guid:"south",net_sales_cents:5000,order_count:2};
describe("Toast date-specific verified location eligibility",()=>{
 it("does not erase sales before a second restaurant's start date",()=>{
  expect(applicableLocations([north,south],"2026-10-05").map(x=>x.restaurant_guid)).toEqual(["north"]);
  expect(dayTotals([north,south],[old],"2026-10-05")).toMatchObject({
   complete:true,netSalesCents:12345,orders:4,checked:true});
 });
 it("requires both applicable restaurants after their start dates",()=>{
  expect(dayCoverage([north,south],[later],"2026-10-12").complete).toBe(false);
  expect(dayTotals([north,south],[later],"2026-10-12")).toMatchObject({
   complete:false,netSalesCents:null,orders:null});
  expect(dayTotals([north,south],[later,southLater],"2026-10-12")).toMatchObject({
   complete:true,netSalesCents:15000,orders:6});
 });
 it("never treats zero eligible locations or unverified locations as complete",()=>{
  expect(dayCoverage([north,south],[],"2026-09-30").complete).toBe(false);
  expect(dayCoverage([{...north,verified_at:null}],[old],"2026-10-05").complete).toBe(false);
 });
 it("unknown cents stays unknown, never zero",()=>{
  expect(dayTotals([north],[{...old,net_sales_cents:null}],"2026-10-05").netSalesCents).toBeNull();
 });
});
