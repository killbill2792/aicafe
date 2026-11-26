import type { RunningCostLine } from "@/lib/data/types";

/** Monthly Menu planning basis only. Do not present projections as observed profit. */
export type MenuPriceSourceDay = {
  businessDate: string;
  salesStatus: "actual" | "missing" | null;
  netSalesCents: number;
  drinksCount: number;
  wagesCents: number | null;
  laborWageStatus?: "actual" | "estimate" | "missing";
  payrollTaxCents: number | null;
  payrollTaxStatus: "actual" | "estimated" | null;
  cardFeesCents: number;
  cardFeesStatus: "actual" | "estimated" | "missing" | null;
};
export type MenuPriceRecurringCost = {
  categoryCode: string;
  amountCents: number;
  frequency: "monthly" | "weekly" | "quarterly" | "yearly";
  estimated: boolean;
};
export type MenuPriceActualExpense = {
  categoryCode: string;
  amountCents: number;
  status: "actual" | "estimated";
};
export type MenuPriceSourceBasis = {
  monthlyRunningCents: number | null;
  runningKnownCents: number;
  missingRunningCategories: string[];
  runningStatus: "recorded" | "estimated" | "missing";
  monthlyPayrollCents: number | null;
  payrollStatus: "projected" | "estimated" | "missing";
  monthlyDrinks: number | null;
  volumeStatus: "projected" | "missing";
  processingFeeBps: number | null;
  /** Exact observed fee rate, before basis-point rounding for display. */
  processingFeeNumeratorCents: number | null;
  processingFeeDenominatorCents: number | null;
  feeStatus: "actual" | "estimated" | "missing";
  monthlyPrepSeconds: number | null;
  coveredDays: number;
  oldestDate: string | null;
  latestDate: string | null;
  payrollCoveredDays: number;
  payrollOldestDate: string | null;
  payrollLatestDate: string | null;
};
const finiteNonnegative = (n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0;
/** Consume canonical monthly cost evidence; only planning projections are computed here. */
export function menuPriceSourceBasis(input:{
  days: MenuPriceSourceDay[];
  runningCosts: Pick<RunningCostLine,"categoryCode"|"amountCents"|"isMissing"|"isExpected"|"isEstimate"|"amountSource"|"forecastOverlapUncertain">[];
  totalItemPrepSecondsInWindow: number;
  /** Trusted café-local current date; recent menu volume and fees use the last 28 days. */
  asOfBusinessDate: string;
  /** Dates with independently verified complete labor coverage, INCLUDING zero-payroll days.
   * Never infer this from positive wages, sales data, or payroll-tax estimate status. */
  laborCoveredDates?: string[];
}):MenuPriceSourceBasis{
  const known=input.runningCosts.filter(row=>!row.isMissing&&row.amountSource!=="missing");
  const runningKnownCents=known.reduce((sum,row)=>sum+row.amountCents,0);
  const missingRunningCategories=input.runningCosts.filter(row=>row.isMissing||row.forecastOverlapUncertain).map(row=>row.categoryCode);
  const monthlyRunningCents=known.length===0||missingRunningCategories.length>0?null:runningKnownCents;
  const runningStatus:MenuPriceSourceBasis["runningStatus"]=monthlyRunningCents===null?"missing":
    known.every(row=>!row.isEstimate&&row.amountSource==="recorded_expense")?"recorded":"estimated";

  // Split sales coverage from labor coverage. A staff-only rollup is valid
  // payroll evidence but is never a covered sales day. Conversely, a sales
  // day with no documented labor is NOT a zero-payroll day.
  const dedupe=(rows:MenuPriceSourceDay[])=>{
    const seen=new Set<string>();
    return rows.filter(d=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(d.businessDate)||seen.has(d.businessDate))return false;
      seen.add(d.businessDate);return true;
    }).sort((a,b)=>a.businessDate.localeCompare(b.businessDate));
  };
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfBusinessDate))
    throw new Error("A valid café-local as-of date is required");
  const end=input.asOfBusinessDate;
  // Running bills are saved for a calendar month, so normalize historical
  // daily volume and staff evidence to this month's true number of days.
  const daysInMonth=new Date(Date.UTC(
    Number(end.slice(0,4)),Number(end.slice(5,7)),0)).getUTCDate();
  const start=new Date(Date.parse(end+"T00:00:00Z")-27*86400000)
    .toISOString().slice(0,10);
  const allDays=dedupe(input.days).filter(d=>d.businessDate<=end);
  const recentDays=allDays.filter(d=>d.businessDate>=start);
  // Canonical Menu economics use the last 28 calendar days when sufficient
  // actual sales exist. Explicit historical-import fallback preserves cafés
  // with >=7 observed days only in older periods; UI shows the source dates.
  const sourceDays=recentDays.filter(d=>d.salesStatus==="actual").length>=7
    ?recentDays:allDays;
  const days=sourceDays.filter(d=>d.salesStatus==="actual");
  const coveredDays=days.length;
  const scale=coveredDays>0?daysInMonth/coveredDays:0;
  const drinks=days.reduce((n,d)=>n+d.drinksCount,0);
  const monthlyDrinks=coveredDays>=7&&drinks>0?Math.round(drinks*scale):null;

  // Positive wage dates prove worked shifts, NOT that intervening zero-shift
  // calendar dates were observed. Project only when a trusted independent
  // import supplies explicit complete labor-covered dates. At present the
  // caller supplies none, so payroll stays missing until owner what-if input.
  const useRecentWindow=sourceDays===recentDays;
  // Preserve verified dates with missing rollups so a partial source can
  // NEVER silently shrink the calendar denominator. The independently
  // covered interval must be consecutive, including real zero-work dates.
  const verifiedLaborDates=new Set((input.laborCoveredDates??[])
    .filter(date=>date<=end&&(!useRecentWindow||date>=start)));
  const orderedLaborDates=[...verifiedLaborDates].sort();
  const continuousLaborCoverage=orderedLaborDates.every((date,i)=>
    i===0||Date.parse(date+"T00:00:00Z")-
      Date.parse(orderedLaborDates[i-1]+"T00:00:00Z")===86400000);
  const payrollDays=sourceDays.filter(d=>verifiedLaborDates.has(d.businessDate)&&
    d.laborWageStatus!=="missing"&&finiteNonnegative(d.wagesCents)&&finiteNonnegative(d.payrollTaxCents));
  const payrollCoveredDays=payrollDays.length;
  const payrollCents=payrollDays.reduce((n,d)=>n+(d.wagesCents??0)+(d.payrollTaxCents??0),0);
  const monthlyPayrollCents=payrollCoveredDays>=7&&
    continuousLaborCoverage&&payrollCoveredDays===verifiedLaborDates.size?
      Math.round(payrollCents*daysInMonth/payrollCoveredDays):null;
  const payrollStatus:MenuPriceSourceBasis["payrollStatus"]=
    monthlyPayrollCents===null?"missing":
      payrollDays.every(d=>d.payrollTaxStatus==="actual")?"projected":"estimated";

  // Canonical effective card rate: sum ALL covered-day processing fees
  // divided by sum ALL covered-day net sales. Refunded/negative-sale days
  // and zero-sale fee adjustments must not disappear from either side.
  const feeReady=coveredDays>=7&&days.every(d=>
    (d.cardFeesStatus==="actual"||d.cardFeesStatus==="estimated")&&
    Number.isSafeInteger(d.netSalesCents)&&Number.isSafeInteger(d.cardFeesCents));
  const revenue=days.reduce((n,d)=>n+d.netSalesCents,0);
  const cardFees=days.reduce((n,d)=>n+d.cardFeesCents,0);
  const exactFeeReady=feeReady&&Number.isSafeInteger(revenue)&&revenue>0&&
    Number.isSafeInteger(cardFees)&&cardFees>=0&&cardFees<=revenue;
  const processingFeeBps=exactFeeReady?
    Math.round(10000*cardFees/revenue):null;
  // Keep raw integer numerator/denominator for per-drink precision.
  const processingFeeNumeratorCents=exactFeeReady?cardFees:null;
  const processingFeeDenominatorCents=exactFeeReady?revenue:null;

  const monthlyPrepSeconds=monthlyDrinks!==null&&
    Number.isSafeInteger(input.totalItemPrepSecondsInWindow)&&
    input.totalItemPrepSecondsInWindow>0
    ?Math.round(input.totalItemPrepSecondsInWindow*scale):null;
  return {monthlyRunningCents,runningKnownCents,missingRunningCategories,runningStatus,monthlyPayrollCents,payrollStatus,
    monthlyDrinks,volumeStatus:monthlyDrinks===null?"missing":"projected",
    processingFeeBps,processingFeeNumeratorCents,processingFeeDenominatorCents,
    feeStatus:processingFeeBps===null?"missing":
      days.every(d=>d.cardFeesStatus==="actual")?"actual":"estimated",
    monthlyPrepSeconds,coveredDays,
    oldestDate:days[0]?.businessDate??null,
    latestDate:days[days.length-1]?.businessDate??null,
    payrollCoveredDays,payrollOldestDate:payrollDays[0]?.businessDate??null,
    payrollLatestDate:payrollDays[payrollDays.length-1]?.businessDate??null};
}
