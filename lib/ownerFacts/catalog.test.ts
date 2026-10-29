import {describe,it,expect} from "vitest";
import {catalogForMissing} from "./catalog";
describe("owner question catalog",()=>{
 it("recognizes payroll, bills, card fees and schedule",()=>{
  expect(catalogForMissing("payroll").type).toBe("money");
  expect(catalogForMissing("monthlyBills").target).toBe("recurring_costs");
  expect(catalogForMissing("cardFeeRate").type).toBe("percent");
  expect(catalogForMissing("get_schedule").type).toBe("text");
 });
 it("scopes dated schedule facts instead of treating every Saturday as the same shift",()=>{
  const item=catalogForMissing("schedule:2026-11-07:2026-11-07");
  expect(item.factKey).toBe("schedule:2026-11-07:2026-11-07");
  expect(item.type).toBe("text");
  expect(item.labelKey).toBe("schedule");
 });
 it("unknown keys remain generic facts",()=>{expect(catalogForMissing("supplier price").type).toBe("text");});
});
