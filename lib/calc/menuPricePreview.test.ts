import { describe, it, expect } from "vitest";
import { menuPricePreview } from "./menuPricePreview";

const base = {
  priceCents:700,ingredientCents:145,monthlyRunningCents:200000,
  monthlyPayrollCents:300000,monthlyDrinks:2000,monthlyPrepSeconds:600000,
  itemPrepSeconds:300,processingFeeBps:300,targetOperatingMarginBps:1500,
};
describe("Menu transparent fully allocated pricing estimate", () => {
  it("uses saved bills, loaded payroll, prep-time share and card fees, not just ingredient benchmark",()=>{
    const p=menuPricePreview(base);
    expect(p).toMatchObject({status:"estimated",ingredientContributionCents:555,
      billsPerDrinkCents:100,laborPerDrinkCents:150,
      cardFeePerDrinkCents:21,allocatedProfitCents:284,
      targetPriceCents:482,laborAllocation:"prep_time"});
  });
  it("accepts fractional cents from a complete recipe and rounds only the final result",()=>{
    const p=menuPricePreview({...base,ingredientCents:145.75});
    expect(p.status).toBe("estimated");
    expect(p.missing).not.toContain("ingredients");
    expect(p.allocatedProfitCents).toBe(283);
    expect(p.targetPriceCents).toBe(483);
  });
  it("makes every missing cost visible rather than pretending it is zero",()=>{
    const p=menuPricePreview({...base,monthlyPayrollCents:null,monthlyDrinks:null,processingFeeBps:null});
    expect(p.status).toBe("missing");
    expect(p.missing).toEqual(["payroll","volume","fees"]);
    expect(p.allocatedProfitCents).toBeNull();
    expect(p.targetPriceCents).toBeNull();
  });
  it("distinguishes an explicitly entered zero from an absent value",()=>{
    const p=menuPricePreview({...base,monthlyRunningCents:0,monthlyPayrollCents:0,processingFeeBps:0});
    expect(p.status).toBe("estimated");
    expect(p.allocatedProfitCents).toBe(555);
  });
  it("uses a disclosed average per drink if item-level prep evidence is missing",()=>{
    const p=menuPricePreview({...base,monthlyPrepSeconds:null});
    expect(p.laborAllocation).toBe("equal_drinks");
    expect(p.laborPerDrinkCents).toBe(150);
  });
  it("uses the exact observed fee fraction until final cent rounding",()=>{
    const nearHalf={...base,priceCents:700,ingredientCents:10,
      monthlyRunningCents:9,monthlyPayrollCents:0,monthlyDrinks:20,
      monthlyPrepSeconds:null,processingFeeBps:301};
    const roundedBps=menuPricePreview(nearHalf);
    const exact=menuPricePreview({...nearHalf,
      processingFeeNumeratorCents:601,processingFeeDenominatorCents:20000});
    expect(roundedBps.allocatedProfitCents).toBe(668);
    expect(exact.allocatedProfitCents).toBe(669);
    expect(exact.cardFeePerDrinkCents).toBe(21);
  });
  it("never invents a target price when the owner margin plus fees leaves no room",()=>{
    const p=menuPricePreview({...base,targetOperatingMarginBps:9900,processingFeeBps:200});
    expect(p.allocatedProfitCents).not.toBeNull();
    expect(p.targetPriceCents).toBeNull();
  });
  it("retains sub-cent precision through final profit and conditional target rounding",()=>{
    const p=menuPricePreview({
      ...base,priceCents:100,ingredientCents:20,
      monthlyRunningCents:2,monthlyPayrollCents:2,monthlyDrinks:5,
      monthlyPrepSeconds:null,processingFeeBps:40,targetOperatingMarginBps:5000,
    });
    // Three 0.4-cent allocations display as 0 cents apiece, but their
    // combined 1.2 cents must not disappear from the final result.
    expect(p).toMatchObject({
      billsPerDrinkCents:0,laborPerDrinkCents:0,cardFeePerDrinkCents:0,
      allocatedProfitCents:79,targetPriceCents:42,
    });
  });

});
