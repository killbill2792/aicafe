import {describe,expect,it} from "vitest";
import {cardFeesForDays,DEFAULT_PROCESSING_FEE_RATE_BPS} from "./fees";
const days=[{date:"2026-10-01",netSalesCents:10000,ordersCount:10,
  cardFeesCents:250,cardFeesStatus:"actual" as const},
 {date:"2026-10-02",netSalesCents:10000,ordersCount:10,
  cardFeesCents:300,cardFeesStatus:"estimated" as const}];
describe("fee priority",()=>{
  it("actual Toast fees win over owner plan over default (fixture f)",()=>{
    const day={date:"2026-10-05",netSalesCents:10000,ordersCount:5,
      cardFeesStatus:"actual" as const,cardFeesCents:179};
    const actual=cardFeesForDays([day],{percentageBps:490,fixedFeeCents:30});
    expect(actual).toMatchObject({amountCents:179,basis:"actual",actualDays:1,estimatedDays:0});
    const plan=cardFeesForDays([{...day,cardFeesStatus:"missing" as const,cardFeesCents:0}],
      {percentageBps:200});
    expect(plan).toMatchObject({amountCents:200,basis:"owner_plan"});
    const fallback=cardFeesForDays([{...day,cardFeesStatus:"missing" as const,cardFeesCents:0}]);
    expect(fallback).toMatchObject({amountCents:290,basis:"default_estimate"});
    expect(fallback.notes).toContain("feeDefaultEstimateAskRate");
  });
  it("uses the effective owner plan for each date in a cross-month range",()=>{
    const plans=[
      {effectiveFrom:"2026-09-01",effectiveTo:"2026-09-30",percentageBps:200},
      {effectiveFrom:"2026-10-01",percentageBps:300},
    ];
    const fee=cardFeesForDays([
      {date:"2026-09-30",netSalesCents:10000,cardFeesStatus:"missing",cardFeesCents:0},
      {date:"2026-10-01",netSalesCents:10000,cardFeesStatus:"missing",cardFeesCents:0},
    ],plans);
    expect(fee.amountCents).toBe(500);
    expect(fee.basis).toBe("owner_plan");
  });

  it("prefers owner plan to estimated daily facts, but not actual facts",()=>{
    expect(cardFeesForDays(days,{percentageBps:200}).amountCents).toBe(450);
    expect(cardFeesForDays(days,{percentageBps:200}).basis).toBe("estimated");
  });
  it("uses actual and estimated facts rather than default",()=>{
    expect(cardFeesForDays([days[0]]).amountCents).toBe(250);
    expect(cardFeesForDays([days[0]]).basis).toBe("actual");
    expect(cardFeesForDays(days).basis).toBe("estimated");
  });
  it("does not certify untyped positive legacy fees",()=>{
    const out=cardFeesForDays([{date:"2026-10-07",netSalesCents:10000,cardFeesCents:155}]);
    expect(out.amountCents).toBe(155);
    expect(out.basis).toBe("estimated");
    expect(out.actualDays).toBe(0);
  });
  it("never treats unqualified zero fees as verified free card processing",()=>{
    const unknown=cardFeesForDays([{date:"2026-10-10",netSalesCents:10000,
      cardFeesCents:0}]);
    expect(unknown.amountCents).toBe(DEFAULT_PROCESSING_FEE_RATE_BPS);
    expect(unknown.basis).toBe("default_estimate");
    expect(cardFeesForDays([{date:"2026-10-10",netSalesCents:10000,
      cardFeesCents:0,cardFeesStatus:"actual"}])).toMatchObject({
      amountCents:0,basis:"actual"});
  });
  it("labels the named default for absent rows and does not hide actual fee cents",()=>{
    const out=cardFeesForDays([{date:"2026-10-03",netSalesCents:10000}]);
    expect(out.amountCents).toBe(DEFAULT_PROCESSING_FEE_RATE_BPS);
    expect(out.basis).toBe("default_estimate");
    expect(out.notes).toContain("feeDefaultEstimateAskRate");
    expect(cardFeesForDays([...days.slice(0,1),{date:"2026-10-03",netSalesCents:10000}]).amountCents).toBe(540);
  });
});
