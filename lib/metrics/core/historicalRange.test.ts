import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import type {BusinessSnapshot} from "@/lib/data/types";
import type {DailyFacts} from "@/lib/calc";

describe("read-only historical period calculation",()=>{
  it("calculates a cross-month partial number using each month's real rent, not current rent twice",()=>{
    const day=(date:string):DailyFacts=>({
      date,netSalesCents:100_000,ingredientsCents:20_000,ordersCount:25,drinksCount:100,
      wagesCents:25_000,staffTaxCents:3_000,cardFeesCents:3_000,
      cardFeesStatus:"actual",laborWageStatus:"actual",staffTaxStatus:"actual",
      salesDataStatus:"actual",voidsCents:0,
    });
    const september=day("2026-09-30"),october=day("2026-10-01");
    const fixture=getFixtureSnapshot();
    const snapshot:BusinessSnapshot & {historicalPeriod:{
      days:DailyFacts[];recorded:DailyFacts[];
      monthlyAmounts:Array<{categoryCode:"rent";monthKey:string;amountCents:number;
        isEstimate:boolean;isMissing:boolean}>;
      missingExpenseCategories:string[];estimatedExpenseCategories:string[];
    }}={
      ...fixture,todayDateStr:"2026-10-02",monthKey:"2026-10",daysInMonth:31,
      monthActualDays:[october],monthRecordedDays:[october],previousMonthDays:[september],
      runningCostLines:[{categoryCode:"rent",label:"Rent",amountCents:310000,
        isEstimate:false,isMissing:false}],
      historicalPeriod:{days:[september,october],recorded:[september,october],
        monthlyAmounts:[
          {categoryCode:"rent",monthKey:"2026-09",amountCents:300000,isEstimate:false,isMissing:false},
          {categoryCode:"rent",monthKey:"2026-10",amountCents:310000,isEstimate:false,isMissing:false}],
        missingExpenseCategories:[],estimatedExpenseCategories:[]},
    };
    const output=cafeStateFromSnapshot(snapshot,{from:"2026-09-30",to:"2026-10-01"});
    expect(output.profitability.available).toBe(true);
    if(!output.profitability.available)throw Error("Expected observed sales");
    expect(output.profitability.value.netSalesCents).toBe(200000);
    expect(output.profitability.value.totalCostsCents).toBe(122000);
    expect(output.profitability.value.ownerProfitCents).toBe(78000);
    expect(output.businessCosts.missingInputs).toContain("historicalIngredientCostCoverage");
    expect(output.expenses.available).toBe(true);
    if(output.expenses.available)expect(output.expenses.value[0].amountCents).toBe(20000);
  });
});
