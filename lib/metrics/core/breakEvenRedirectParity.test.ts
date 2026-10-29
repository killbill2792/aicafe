import {describe,it,expect} from "vitest";
import {dailyCostsToCoverCents} from "@/lib/calc/breakEven";
import {dailyBreakEvenCostsCents} from "./breakEven";
import {FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,FIXTURE_A_DAY} from "@/lib/calc/__fixtures__/fixtureA";

describe("before redirect: legacy daily break-even vs canonical",()=>{
 it("full actual labor and recorded daily bills match exactly",()=>{
  expect(dailyCostsToCoverCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,FIXTURE_A_DAY.staffCostCents))
    .toBe(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,FIXTURE_A_DAY.staffCostCents));
 });
 it("missing labor is a labeled zero floor, preserving the displayed numeric basis",()=>{
  const floor=0;
  expect(dailyCostsToCoverCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,floor))
    .toBe(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,floor));
 });
 it("a day with missing processing fees does not change the bills-plus-labor primitive",()=>{
  const missingFeeDay={...FIXTURE_A_DAY,cardFeesCents:null};
  expect(missingFeeDay.cardFeesCents).toBeNull();
  expect(dailyCostsToCoverCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,missingFeeDay.staffCostCents))
    .toBe(dailyBreakEvenCostsCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,missingFeeDay.staffCostCents));
 });
});
