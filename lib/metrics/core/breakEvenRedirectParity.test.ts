import {describe,it,expect} from "vitest";
import {dailyBreakEvenCostsCents} from "./breakEven";
import {FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,FIXTURE_A_DAY} from "@/lib/calc/__fixtures__/fixtureA";

describe("before redirect: legacy daily break-even vs canonical",()=>{
 it("full actual labor and recorded daily bills match exactly",()=>{
  expect(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,FIXTURE_A_DAY.staffCostCents)).toBe(109952);
 });
 it("missing labor is a labeled zero floor, preserving the displayed numeric basis",()=>{
  const floor=0;
  expect(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,floor)).toBe(32000);
 });
 it("a day with missing processing fees does not change the bills-plus-labor primitive",()=>{
  const missingFeeDay={...FIXTURE_A_DAY,cardFeesCents:null};
  expect(missingFeeDay.cardFeesCents).toBeNull();
  expect(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,missingFeeDay.staffCostCents)).toBe(109952);
 });
});
