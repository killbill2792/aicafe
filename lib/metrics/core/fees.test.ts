import {describe,expect,it} from "vitest";
import {cardFeesForDays,DEFAULT_PROCESSING_FEE_RATE_BPS} from "./fees";
const days=[{date:"2026-10-01",netSalesCents:10000,ordersCount:10,
  cardFeesCents:250,cardFeesStatus:"actual" as const},
 {date:"2026-10-02",netSalesCents:10000,ordersCount:10,
  cardFeesCents:300,cardFeesStatus:"estimated" as const}];
describe("fee priority",()=>{
  it("uses the effective owner plan for each date in a cross-month range",()=>{
    const plans=[
      {effectiveFrom:"2026-09-01",effectiveTo:"2026-09-30",percentageBps:200},
      {effectiveFrom:"2026-10-01",percentageBps:300},
    ];
    const fee=cardFeesForDays([
      {date:"2026-09-30",netSalesCents:10000,cardFeesStatus:"actual",cardFeesCents:999},
      {date:"2026-10-01",netSalesCents:10000,cardFeesStatus:"actual",cardFeesCents:999},
    ],plans);
    expect(fee.amountCents).toBe(500);
    expect(fee.basis).toBe("owner_plan");
  });

  it("uses owner plan before stored fee facts",()=>{
    expect(cardFeesForDays(days,{percentageBps:200}).amountCents).toBe(400);
    expect(cardFeesForDays(days,{percentageBps:200}).basis).toBe("owner_plan");
  });
  it("uses actual and estimated facts rather than default",()=>{
    expect(cardFeesForDays([days[0]]).amountCents).toBe(250);
    expect(cardFeesForDays([days[0]]).basis).toBe("actual");
    expect(cardFeesForDays(days).basis).toBe("estimated");
  });
  it("labels the named default for absent rows and does not hide actual fee cents",()=>{
    const out=cardFeesForDays([{date:"2026-10-03",netSalesCents:10000}]);
    expect(out.amountCents).toBe(DEFAULT_PROCESSING_FEE_RATE_BPS);
    expect(out.basis).toBe("default_estimate");
    expect(out.notes).toContain("feeDefaultEstimateAskRate");
    expect(cardFeesForDays([...days.slice(0,1),{date:"2026-10-03",netSalesCents:10000}]).amountCents).toBe(540);
  });
});
