import type {BusinessSnapshot} from "@/lib/data/types";
import type {DailyFacts} from "@/lib/calc";
import {
  ingredientsCentsForPeriod,staffCostCentsForPeriod,cardFeesCentsForPeriod,
  totalCostsCentsForPeriod,runningCostsForPeriodCents,roundHalfUpToCent,
} from "@/lib/calc";
import type {BusinessCostSummary,CafeStatePeriod} from "./types";
import {previousMonthKey,runningCostsForPeriod} from "@/lib/viewmodels/period";

/** Shared business-cost observation for Money and Supervisor.
 * This is NOT a verified profit figure; absent amounts stay absent.
 * Arithmetic delegates entirely to the same canonical Money/calc helpers.
 */
export function businessCostSummaryFromSnapshot(snapshot:BusinessSnapshot,period:CafeStatePeriod):BusinessCostSummary {
  const crossesToPreviousMonth=period.from<snapshot.monthKey+"-01";
  const previousMonth=previousMonthKey(snapshot.monthKey);
  const weekStart=new Date(Date.parse(snapshot.todayDateStr+"T12:00:00Z")-
    6*86_400_000).toISOString().slice(0,10);
  // Money's Week is a seven-calendar-day window even on October 1–6.
  // Do not extend this historical availability exception to arbitrary prior months.
  const supported=period.from>=(crossesToPreviousMonth?previousMonth+"-01":snapshot.monthKey+"-01")&&
    (!crossesToPreviousMonth||(period.from===weekStart&&period.to===snapshot.todayDateStr))&&
    period.to<=snapshot.todayDateStr&&period.from<=period.to&&
    /^\d{4}-\d{2}-\d{2}$/.test(period.from)&&/^\d{4}-\d{2}-\d{2}$/.test(period.to)&&
    !Number.isNaN(Date.parse(period.from+"T00:00:00Z"))&&
    !Number.isNaN(Date.parse(period.to+"T00:00:00Z"))&&
    new Date(period.from+"T00:00:00Z").toISOString().slice(0,10)===period.from&&
    new Date(period.to+"T00:00:00Z").toISOString().slice(0,10)===period.to;
  const empty={period,completeness:"unavailable" as const,knownTotalCents:0,
    components:{ingredientsCents:0,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
    observed:{ingredients:false,loadedStaff:false,cardFees:false,runningCosts:false},
    missingInputs:["periodOutsideLoadedMonth"],estimatedInputs:[],
    coverage:{salesDays:0,laborDays:0,expectedDays:0,missingProductCostCount:0,
      missingFeeDays:0,itemSalesCovered:false,soldProductCount:null,
      estimatedProductCostCount:0,
      historicalIngredientCostsProven:false,
      soldProductIds:[] as string[],missingProductCostIds:[] as string[],
      estimatedProductCostIds:[] as string[],
      missingOperatingCategories:[] as Array<{code:string;label:string}>}};
  if(!supported)return empty;
  const salesDays=[...(crossesToPreviousMonth?snapshot.previousMonthDays:[]),
    ...snapshot.monthActualDays].filter(d=>d.date>=period.from&&d.date<=period.to&&
    d.salesDataStatus!=="missing");
  const recordedDays=[
    ...(crossesToPreviousMonth?(snapshot.previousMonthRecordedDays??snapshot.previousMonthDays):[]),
    ...(snapshot.monthRecordedDays??snapshot.monthActualDays),
  ].filter(d=>d.date>=period.from&&d.date<=period.to);
  const saleDates=new Set(salesDays.map(d=>d.date)),laborDates=new Set(recordedDays.map(d=>d.date));
  const expectedDays=Math.round((Date.parse(period.to+"T00:00:00Z")-
    Date.parse(period.from+"T00:00:00Z"))/86_400_000)+1;
  const participation=snapshot.periodItemSales;
  const samePeriod=participation?.period.from===period.from&&
    participation.period.to===period.to;
  // An explicitly sales-covered $0-order period proves no sold products even
  // when an import cannot attest to item-level order-line coverage. Never use
  // an ingredientsCents=0 aggregate as equivalent evidence for POSITIVE sales.
  const provenZeroSales=saleDates.size===expectedDays&&salesDays.every(day=>
    day.salesDataStatus==="actual"&&day.netSalesCents===0&&day.ordersCount===0);
  const reportedSold=samePeriod&&participation?.covered===true
    ? (participation.soldItems??[]).filter(x=>Number.isFinite(x.units)&&x.units>0)
    : [];
  // A positive aggregate with no matching item quantities may be an import
  // without line details or unlinked POS items; never claim ingredient coverage.
  const positiveSales=salesDays.some(day=>day.ordersCount>0||day.netSalesCents>0);
  const itemSalesCovered=provenZeroSales||(
    samePeriod&&participation?.covered===true&&(!positiveSales||reportedSold.length>0));
  const soldItems=itemSalesCovered&&!provenZeroSales?reportedSold:[];
  const products=new Map((snapshot.allCostProducts??snapshot.menuItems).map(item=>[item.id,item]));
  const missingProducts=soldItems.filter(x=>!products.get(x.id)||
    products.get(x.id)?.costStatus!=="READY");
  const estimatedProducts=soldItems.filter(x=>products.get(x.id)?.costQuality==="estimated");
  // Historical recipe lines are mutable and have NO effective/version timestamps.
  // Today's READY status (including a recipe added after a sale) is not proof that
  // a historical daily_rollups.ingredients_cents included that item's cost.
  // Only an explicit previous historical recomputation/provenance, scoped to
  // every non-zero sold date and reconciled to the *stored* rollup, can prove it.
  const priorProof=participation?.historicalIngredientCostProof;
  const proofByDay=new Map(priorProof?.days.map(d=>[d.date,d.ingredientsCents])??[]);
  const soldSalesDays=salesDays.filter(d=>d.ordersCount>0||d.netSalesCents>0);
  const historicalIngredientCostsProven=provenZeroSales||(
    itemSalesCovered&&samePeriod&&priorProof?.source==="historical_recomputation"&&
    proofByDay.size===soldSalesDays.length&&soldSalesDays.length>0&&
    soldSalesDays.every(d=>proofByDay.has(d.date)&&
      proofByDay.get(d.date)===d.ingredientsCents&&
      Number.isInteger(d.ingredientsCents)&&d.ingredientsCents>=0));

  const missingExpenses=snapshot.runningCostLines.filter(line=>line.isExpected&&line.isMissing);
  const estimatedExpenses=snapshot.runningCostLines.filter(line=>!line.isMissing&&line.isEstimate);
  const feeDays=salesDays.filter(day=>day.netSalesCents>0&&day.cardFeesStatus==="missing");
  const estimatedFees=salesDays.filter(day=>day.cardFeesStatus==="estimated");
  const estimatedTax=recordedDays.filter(day=>day.staffTaxStatus==="estimated");
  const monthly=snapshot.runningCostLines.map(line=>({
    categoryCode:line.categoryCode,monthKey:snapshot.monthKey,
    amountCents:line.isMissing?0:line.amountCents,
    isMissing:line.isMissing,isEstimate:line.isEstimate,
  }));
  const running=crossesToPreviousMonth
    ? runningCostsForPeriod(snapshot,"week")
    : runningCostsForPeriodCents(monthly,period.from,period.to);
  // Sales and staff can be recorded independently. Use sales-covered rows ONLY for
  // ingredients/fees and recorded rows ONLY for labor, never adding labor twice.
  const ingredient=ingredientsCentsForPeriod(salesDays);
  const staff=staffCostCentsForPeriod(recordedDays);
  const fees=cardFeesCentsForPeriod(salesDays.filter(day=>day.cardFeesStatus!=="missing"||day.netSalesCents===0));
  // Reuse exact Money total-cost helper with cost-only projected contributions.
  const costDays:DailyFacts[]=[
    ...salesDays.map(day=>({...day,wagesCents:0,staffTaxCents:0,
      cardFeesCents:day.cardFeesStatus==="missing"&&day.netSalesCents>0?0:day.cardFeesCents})),
    ...recordedDays.map(day=>({...day,ingredientsCents:0,cardFeesCents:0})),
  ];
  const knownTotalCents=roundHalfUpToCent(totalCostsCentsForPeriod(costDays,running));
  const missingInputs=[
    ...(saleDates.size<expectedDays?["salesCoverage:"+saleDates.size+"/"+expectedDays]:[]),
    ...(laborDates.size<expectedDays?["laborCoverage:"+laborDates.size+"/"+expectedDays]:[]),
    ...missingExpenses.map(x=>"expense:"+x.categoryCode),
    // Money's supported cross-month Week prorates prior-month bills using
    // THIS month's rates. Preserve its subtotal, but do not call assumed
    // historical operating costs a complete verified total.
    ...(crossesToPreviousMonth&&snapshot.runningCostLines.some(line=>
      !line.isMissing&&line.amountCents!==0)?["priorMonthRunningCostCoverage"]:[]),
    ...(!itemSalesCovered?["itemSalesCoverage"]:[]),
    ...(itemSalesCovered&&!historicalIngredientCostsProven?["historicalIngredientCostCoverage"]:[]),
    ...missingProducts.map(x=>"productCost:"+x.id),
    ...feeDays.map(x=>"cardFees:"+x.date),
  ];
  const estimatedInputs=[
    ...estimatedExpenses.map(x=>"expense:"+x.categoryCode),
    ...(crossesToPreviousMonth?["priorMonthRunningCostEstimate"]:[]),
    ...estimatedProducts.map(x=>"productCost:"+x.id),
    ...estimatedFees.map(x=>"cardFees:"+x.date),
    ...estimatedTax.map(x=>"staffTax:"+x.date),
  ];
  const observed={ingredients:salesDays.length>0,loadedStaff:recordedDays.length>0,
    cardFees:salesDays.length>0,runningCosts:snapshot.runningCostLines.some(line=>!line.isMissing)};
  const anyKnown=Object.values(observed).some(Boolean);
  return {
    period,knownTotalCents:anyKnown?knownTotalCents:0,
    completeness:!anyKnown?"unavailable":missingInputs.length?"partial":"complete",
    components:{ingredientsCents:ingredient,loadedStaffCents:staff,
      cardFeesCents:fees,runningCostsCents:roundHalfUpToCent(running)},
    observed,missingInputs,estimatedInputs,
    coverage:{salesDays:saleDates.size,laborDays:laborDates.size,expectedDays,
      missingProductCostCount:missingProducts.length,missingFeeDays:feeDays.length,
      itemSalesCovered,soldProductCount:itemSalesCovered?soldItems.length: null,
      estimatedProductCostCount:estimatedProducts.length,
      historicalIngredientCostsProven,
      soldProductIds:soldItems.map(item=>item.id),
      missingProductCostIds:missingProducts.map(item=>item.id),
      estimatedProductCostIds:estimatedProducts.map(item=>item.id),
      missingOperatingCategories:missingExpenses.map(line=>({code:line.categoryCode,label:line.label})).slice(0,8)},
  };
}
