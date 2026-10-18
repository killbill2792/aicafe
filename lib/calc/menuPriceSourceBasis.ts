import { recurringCostMonthlyEquivalentCents } from "@/lib/expenses/recurringMonthlyTotal";

/** Explicitly bounded historical evidence for a Menu-only monthly what-if.
 * A 14-day import from an earlier month is evidence, not a current-month actual.
 * No missing day may be treated as a zero-sales or zero-payroll day.
 */
export type MenuPriceSourceDay = {
  businessDate: string;
  salesStatus: "actual" | "missing" | null;
  netSalesCents: number;
  drinksCount: number;
  wagesCents: number;
  payrollTaxCents: number;
  payrollTaxStatus: "actual" | "estimated" | null;
  cardFeesCents: number;
  cardFeesStatus: "actual" | "estimated" | "missing" | null;
};
export type MenuPriceRecurringCost = {
  amountCents: number;
  frequency: "monthly" | "weekly" | "quarterly" | "yearly";
  estimated: boolean;
};
export type MenuPriceSourceBasis = {
  monthlyRunningCents: number | null;
  runningStatus: "recorded" | "estimated" | "missing";
  monthlyPayrollCents: number | null;
  payrollStatus: "projected" | "missing";
  monthlyDrinks: number | null;
  volumeStatus: "projected" | "missing";
  processingFeeBps: number | null;
  feeStatus: "actual" | "estimated" | "missing";
  monthlyPrepSeconds: number | null;
  coveredDays: number;
  oldestDate: string | null;
  latestDate: string | null;
};

/** Monthly equivalents are never added to loaded staff, ingredients or card fees. */
export function menuPriceSourceBasis(input:{
  days: MenuPriceSourceDay[];
  recurring: MenuPriceRecurringCost[];
  totalItemPrepSecondsInWindow: number;
}):MenuPriceSourceBasis{
  const monthlyRunningCents = input.recurring.length
    ? input.recurring.reduce((sum,row)=>
        sum+recurringCostMonthlyEquivalentCents({amountCents:row.amountCents,
          frequency:row.frequency}),0) : null;
  const runningStatus: MenuPriceSourceBasis["runningStatus"] = monthlyRunningCents===null ? "missing" :
    input.recurring.some(r=>r.estimated) ? "estimated" : "recorded";

  // Keep one rollup per date and fail closed on duplicate coverage records.
  const seen = new Set<string>();
  const days=input.days.filter(d=>{
    if(d.salesStatus!=="actual"||seen.has(d.businessDate))return false;
    seen.add(d.businessDate);return true;
  }).sort((a,b)=>a.businessDate.localeCompare(b.businessDate));
  const coveredDays=days.length;
  const scale=coveredDays>0?30/coveredDays:0;
  const drinks=days.reduce((n,d)=>n+d.drinksCount,0);
  const monthlyDrinks=coveredDays>=7&&drinks>0?Math.round(drinks*scale):null;

  const payroll=days.reduce((n,d)=>n+d.wagesCents+d.payrollTaxCents,0);
  const hasPayrollEvidence=days.some(d=>d.wagesCents>0||d.payrollTaxCents>0)||
    (days.length>0&&days.every(d=>d.payrollTaxStatus==="actual"));
  const monthlyPayrollCents=coveredDays>=7&&hasPayrollEvidence
    ?Math.round(payroll*scale):null;

  const feeSales=days.filter(d=>d.netSalesCents>0);
  const feeReady=coveredDays>=7&&feeSales.length>0&&
    feeSales.every(d=>d.cardFeesStatus==="actual"||d.cardFeesStatus==="estimated");
  const revenue=feeSales.reduce((n,d)=>n+d.netSalesCents,0);
  const cardFees=feeSales.reduce((n,d)=>n+d.cardFeesCents,0);
  const processingFeeBps=feeReady&&revenue>0
    ?Math.round(10000*cardFees/revenue):null;

  const monthlyPrepSeconds=monthlyDrinks!==null&&
    Number.isSafeInteger(input.totalItemPrepSecondsInWindow)&&
    input.totalItemPrepSecondsInWindow>0
    ?Math.round(input.totalItemPrepSecondsInWindow*scale):null;
  return {monthlyRunningCents,runningStatus,monthlyPayrollCents,
    payrollStatus:monthlyPayrollCents===null?"missing":"projected",
    monthlyDrinks,volumeStatus:monthlyDrinks===null?"missing":"projected",
    processingFeeBps,feeStatus:processingFeeBps===null?"missing":
      feeSales.every(d=>d.cardFeesStatus==="actual")?"actual":"estimated",
    monthlyPrepSeconds,coveredDays,
    oldestDate:days[0]?.businessDate??null,
    latestDate:days[days.length-1]?.businessDate??null};
}
