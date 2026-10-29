import {describe,it,expect} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import type {BusinessSnapshot} from "@/lib/data/types";
import type {DailyFacts} from "@/lib/calc";
import {cafeStateFromSnapshot} from "@/lib/operating/cafeState";
import {buildProfitAndCostsViewModel} from "@/lib/viewmodels/moneyViewModel";
import {moneyTools} from "@/lib/ai/agent/tools/money";
import type {AgentToolContext} from "@/lib/ai/agent/tools/index";
import {shiftCafeDate} from "./clock";

/** Golden owner questions: fixed café facts with answers worked out by hand.
 * Each answer must come out exactly the same from the Money screen and from
 * the chat's tools. A change to either path that moves a number fails here. */

type Case="complete"|"fees_missing"|"wage_missing"|"bill_missing";
const DAYS=29,SALES=240_000,INGREDIENTS=65_000,FEES=7_000,WAGES=69_600,TAX=8_352,RENT=300_000;

function cafe(kind:Case):BusinessSnapshot{
  const day=(i:number):DailyFacts=>({
    date:shiftCafeDate("2026-09-01",i),netSalesCents:SALES,ingredientsCents:INGREDIENTS,
    cardFeesCents:kind==="fees_missing"?0:FEES,cardFeesStatus:kind==="fees_missing"?"missing":"actual",
    wagesCents:kind==="wage_missing"&&i===0?null:WAGES,staffTaxCents:TAX,
    laborWageStatus:kind==="wage_missing"&&i===0?"missing":"actual",
    ordersCount:240,drinksCount:480,voidsCents:0,staffTaxStatus:"actual",salesDataStatus:"actual",
  });
  const days=Array.from({length:DAYS},(_,i)=>day(i));
  const fixture=getFixtureSnapshot();
  return {...fixture,todayDateStr:days[DAYS-1].date,monthKey:"2026-09",daysInMonth:30,
    monthActualDays:days,monthRecordedDays:days,last28Days:days,last7Days:days.slice(-7),
    todayDay:days[DAYS-1],todayHasData:true,previousMonthDays:[],
    periodItemSales:{...fixture.periodItemSales!,period:{from:"2026-09-01",to:days[DAYS-1].date},
      historicalIngredientCostProof:{source:"historical_recomputation",
        days:days.map(d=>({date:d.date,ingredientsCents:d.ingredientsCents}))}},
    runningCostLines:[{categoryCode:"rent",label:"Rent",amountCents:kind==="bill_missing"?0:RENT,
      isEstimate:false,isMissing:kind==="bill_missing",isExpected:true}],
  } as BusinessSnapshot;
}

async function answers(kind:Case){
  const snapshot=cafe(kind);
  const period={from:"2026-09-01",to:snapshot.todayDateStr};
  const screen=buildProfitAndCostsViewModel(snapshot,"month");
  const state=cafeStateFromSnapshot(snapshot,period);
  const ctx={asOf:snapshot.todayDateStr,timezone:snapshot.business.timezone,locale:"en",currency:snapshot.business.currency??null,
    tools:{getBusinessCostSummary:async()=>cafeStateFromSnapshot(snapshot,period).businessCosts},
  } as unknown as AgentToolContext;
  const costs=await moneyTools.get_cost_summary.execute({period:"month"},ctx) as unknown as {
    knownTotalCents:number|null;estimated:string[];missing:string[];
    components:{ingredientsCents:number|null;loadedStaffCents:number|null;cardFeesCents:number|null;runningCostsCents:number|null}};
  if(!state.profitability.available)throw new Error("profit unavailable");
  return {screen,costs,profit:state.profitability.value};
}

// Hand-worked answers for the September café, 1–29 September, rent 3,000.00 a month.
const RENT_29_DAYS=RENT*DAYS/30;                          // 2,900.00
const BASE_COSTS=DAYS*(INGREDIENTS+FEES+WAGES+TAX)+RENT_29_DAYS;

describe("golden owner questions — screen and chat give the same hand-worked answer",()=>{
  it("1. How much did I sell this month?",async()=>{
    const {screen,profit}=await answers("complete");
    expect(screen.salesCents).toBe(6_960_000);
    expect(profit.netSalesCents).toBe(6_960_000);
  });
  it("2. What did ingredients cost me?",async()=>{
    const {screen,costs}=await answers("complete");
    expect(screen.ingredientsCents).toBe(1_885_000);
    expect(costs.components.ingredientsCents).toBe(1_885_000);
  });
  it("3. How much went to card fees?",async()=>{
    const {screen,costs}=await answers("complete");
    expect(screen.cardFeesCents).toBe(203_000);
    expect(costs.components.cardFeesCents).toBe(203_000);
  });
  it("4. What did staff cost, including payroll tax?",async()=>{
    const {screen,costs}=await answers("complete");
    expect(screen.wagesCents!+screen.staffTaxCents!).toBe(2_260_608);
    expect(costs.components.loadedStaffCents).toBe(2_260_608);
  });
  it("5. What share of the month's bills applies so far?",async()=>{
    const {screen,costs}=await answers("complete");
    expect(RENT_29_DAYS).toBe(290_000);
    expect(screen.runningCostLines.reduce((s,l)=>s+l.amountCents,0)).toBe(290_000);
    expect(costs.components.runningCostsCents).toBe(290_000);
  });
  it("6. What are my total costs?",async()=>{
    const {screen,costs,profit}=await answers("complete");
    expect(BASE_COSTS).toBe(4_638_608);
    expect(screen.totalCostsCents).toBe(4_638_608);
    expect(costs.knownTotalCents).toBe(4_638_608);
    expect(profit.totalCostsCents).toBe(4_638_608);
  });
  it("7. Did I make money this month?",async()=>{
    const {screen,profit}=await answers("complete");
    expect(screen.ownerProfitCents).toBe(2_321_392);
    expect(profit.ownerProfitCents).toBe(2_321_392);
  });
  it("8. Card fees are missing: the cost uses the labelled 2.9% estimate on both paths",async()=>{
    const {screen,costs,profit}=await answers("fees_missing");
    // 29 days x 2,400.00 x 2.9% = 2,018.40
    expect(screen.cardFeesCents).toBe(201_840);
    expect(costs.components.cardFeesCents).toBe(201_840);
    expect(costs.estimated).toContain("cardFees:defaultRate");
    expect(screen.totalCostsCents).toBe(BASE_COSTS-203_000+201_840);
    expect(costs.knownTotalCents).toBe(screen.totalCostsCents);
    expect(profit.ownerProfitCents).toBe(screen.ownerProfitCents);
  });
  it("9. One day's wage is missing: the known staff cost leaves out only that wage",async()=>{
    const {screen,costs}=await answers("wage_missing");
    // 28 known wages + 29 recorded payroll-tax amounts.
    expect(screen.wagesCents!+screen.staffTaxCents!).toBe(28*WAGES+29*TAX);
    // The chat does not present a partial staff figure as the full staff cost;
    // the known part is inside the total and the missing wage is named.
    expect(costs.components.loadedStaffCents).toBeNull();
    expect(costs.knownTotalCents).toBe(BASE_COSTS-WAGES);
    expect(screen.totalCostsCents).toBe(BASE_COSTS-WAGES);
    expect(costs.missing).toContain("laborWageUnknown:2026-09-01");
  });
  it("10. Rent is not entered: costs leave it out and say it is missing",async()=>{
    const {screen,costs}=await answers("bill_missing");
    expect(costs.knownTotalCents).toBe(BASE_COSTS-RENT_29_DAYS);
    expect(screen.totalCostsCents).toBe(BASE_COSTS-RENT_29_DAYS);
    expect(costs.missing).toContain("expense:rent");
    expect(screen.financialNotes).toContain("profitBillsMissing");
  });
});
