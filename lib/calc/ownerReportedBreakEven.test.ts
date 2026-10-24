import {describe,it,expect} from "vitest";
import {ownerReportedDailyBreakEven,recordedDailyFixedCosts,percentToBasisPoints} from "./ownerReportedBreakEven";
describe("owner-provided break-even assumptions",()=>{
  it("combines recorded daily overhead with the owner's 20% variable cost and sales",()=>{
    // $16,266.52 / 23 days = $707.24 recorded daily overhead.
    const dailyCosts=Math.round(1_626_652/23);
    const result=ownerReportedDailyBreakEven({dailyFixedCostsCents:dailyCosts,
      ingredientPackagingBps:2000,netSalesCents:1_100_000,salesDays:22});
    expect(result).toMatchObject({
      dailyFixedCostsCents:70724,contributionBps:8000,
      dailyBreakEvenSalesCents:88405,dailyNetSalesCents:50000,dailyShortfallCents:38405,
    });
  });
  it("does not divide by zero or pretend missing owner sales are zero",()=>{
    expect(ownerReportedDailyBreakEven({dailyFixedCostsCents:70724,ingredientPackagingBps:10000})).toBeNull();
    expect(ownerReportedDailyBreakEven({dailyFixedCostsCents:70724,ingredientPackagingBps:2000})
      ?.dailyNetSalesCents).toBeNull();
  });
  it("subtracts processing fees when supplied and flags when excluded",()=>{
    const withFees=ownerReportedDailyBreakEven({
      dailyFixedCostsCents:10000,ingredientPackagingBps:2000,processingFeeBps:300,
    });
    expect(withFees).toMatchObject({
      dailyBreakEvenSalesCents:12988,contributionBps:7700,
      processingFeesIncluded:true,processingFeeBps:300,
    });
    const withoutFees=ownerReportedDailyBreakEven({
      dailyFixedCostsCents:10000,ingredientPackagingBps:2000,
    });
    expect(withoutFees).toMatchObject({
      dailyBreakEvenSalesCents:12500,processingFeesIncluded:false,processingFeeBps:null,
    });
  });
});
describe("pure fixed-cost daily averaging",()=>{
  it("combines labor and running costs then rounds once in integer cents",()=>{
    expect(recordedDailyFixedCosts({
      loadedStaffCents:1000000,runningCostsCents:626652,expectedDays:23,
    })).toBe(70724);
    // Aggregation precedes rounding: rounding components separately is not equivalent.
    expect(recordedDailyFixedCosts({
      loadedStaffCents:1,runningCostsCents:1,expectedDays:3,
    })).toBe(1);
    expect(recordedDailyFixedCosts({
      loadedStaffCents:0,runningCostsCents:0,expectedDays:30,
    })).toBe(0);
  });
  it("rejects invalid days, negative/partial and unsafe monetary inputs",()=>{
    const base={loadedStaffCents:100,runningCostsCents:300,expectedDays:20};
    expect(recordedDailyFixedCosts({...base,expectedDays:0})).toBeNull();
    expect(recordedDailyFixedCosts({...base,expectedDays:1.5})).toBeNull();
    expect(recordedDailyFixedCosts({...base,loadedStaffCents:-1})).toBeNull();
    expect(recordedDailyFixedCosts({...base,runningCostsCents:NaN})).toBeNull();
    expect(recordedDailyFixedCosts({...base,loadedStaffCents:Number.MAX_SAFE_INTEGER})).toBeNull();
  });
});

describe("owner percent input conversion",()=>{
  it("converts known percentages without float cents rounding in handlers",()=>{
    expect(percentToBasisPoints(20)).toBe(2000);
    expect(percentToBasisPoints(3.25)).toBe(325);
    expect(percentToBasisPoints(99.99)).toBe(9999);
    expect(percentToBasisPoints(0)).toBe(0);
    expect(percentToBasisPoints(null)).toBeNull();
    expect(percentToBasisPoints(undefined)).toBeNull();
  });
  it("refuses invalid percentages",()=>{
    expect(percentToBasisPoints(-1)).toBeNull();
    expect(percentToBasisPoints(100)).toBeNull();
    expect(percentToBasisPoints(NaN)).toBeNull();
    expect(percentToBasisPoints(Infinity)).toBeNull();
  });
});

describe("large-cent exactness and overflow",()=>{
  it("rounds up in integer arithmetic even when cents times 10,000 exceeds Number precision",()=>{
    const exact=ownerReportedDailyBreakEven({
      dailyFixedCostsCents:900719925475,ingredientPackagingBps:2500,
    });
    const expected=(BigInt(900719925475)*BigInt(10000)+BigInt(7499))/BigInt(7500);
    expect(exact?.dailyBreakEvenSalesCents).toBe(Number(expected));
  });
  it("refuses results greater than the safe integer money range",()=>{
    expect(ownerReportedDailyBreakEven({
      dailyFixedCostsCents:Number.MAX_SAFE_INTEGER,ingredientPackagingBps:2000,
    })).toBeNull();
  });
});
