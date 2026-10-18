import { recurringCostMonthlyEquivalentCents } from "@/lib/expenses/recurringMonthlyTotal";
import { RUNNING_COST_CODES } from "@/lib/constants";

/** Monthly Menu planning basis only. Do not present projections as observed profit. */
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
  runningStatus: "recorded" | "estimated" | "missing";
  monthlyPayrollCents: number | null;
  payrollStatus: "projected" | "estimated" | "missing";
  monthlyDrinks: number | null;
  volumeStatus: "projected" | "missing";
  processingFeeBps: number | null;
  feeStatus: "actual" | "estimated" | "missing";
  monthlyPrepSeconds: number | null;
  coveredDays: number;
  oldestDate: string | null;
  latestDate: string | null;
  payrollCoveredDays: number;
  payrollOldestDate: string | null;
  payrollLatestDate: string | null;
};
const finiteNonnegative = (n:number)=>Number.isSafeInteger(n)&&n>=0;
const runningCodes = new Set<string>(RUNNING_COST_CODES);
/**
 * The canonical "actual expense by category, otherwise recurring estimate"
 * precedence applies here too. An owner receipt replaces a schedule amount,
 * never adds on top of it. All expenses are caller-filtered to the same
 * current calendar month and business.
 */
export function menuPriceSourceBasis(input:{
  days: MenuPriceSourceDay[];
  recurring: MenuPriceRecurringCost[];
  expenses: MenuPriceActualExpense[];
  totalItemPrepSecondsInWindow: number;
}):MenuPriceSourceBasis{
  // Canonical monthlyAmountForCategory: ALL recorded expense rows win over
  // recurring schedules, including estimated rows. Preserve estimate quality.
  const expenseByCategory = new Map<string,{cents:number,estimated:boolean}>();
  for(const row of input.expenses){
    if(!runningCodes.has(row.categoryCode)||!finiteNonnegative(row.amountCents))continue;
    const prior=expenseByCategory.get(row.categoryCode)??{cents:0,estimated:false};
    expenseByCategory.set(row.categoryCode,{
      cents:prior.cents+row.amountCents,
      estimated:prior.estimated||row.status==="estimated",
    });
  }
  const recurringByCategory = new Map<string,{cents:number,estimated:boolean}>();
  for(const row of input.recurring){
    if(!runningCodes.has(row.categoryCode)||!finiteNonnegative(row.amountCents))continue;
    const amount=recurringCostMonthlyEquivalentCents({amountCents:row.amountCents,
      frequency:row.frequency});
    const prior=recurringByCategory.get(row.categoryCode)??{cents:0,estimated:false};
    recurringByCategory.set(row.categoryCode,{cents:prior.cents+amount,
      estimated:prior.estimated||row.estimated});
  }
  const allCategories = new Set([...expenseByCategory.keys(),...recurringByCategory.keys()]);
  const monthlyRunningCents=allCategories.size===0?null:
    [...allCategories].reduce((sum,category)=>
      sum+(expenseByCategory.get(category)?.cents??recurringByCategory.get(category)!.cents),0);
  const runningStatus:MenuPriceSourceBasis["runningStatus"]=
    monthlyRunningCents===null?"missing":
    [...allCategories].every(category=>{
      const expense=expenseByCategory.get(category);
      return expense!==undefined&&!expense.estimated;
    })?"recorded":"estimated";

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
  const allDays=dedupe(input.days);
  const days=allDays.filter(d=>d.salesStatus==="actual");
  const coveredDays=days.length;
  const scale=coveredDays>0?30/coveredDays:0;
  const drinks=days.reduce((n,d)=>n+d.drinksCount,0);
  const monthlyDrinks=coveredDays>=7&&drinks>0?Math.round(drinks*scale):null;

  const payrollDays=allDays.filter(d=>
    (d.wagesCents>0||d.payrollTaxCents>0) &&
    finiteNonnegative(d.wagesCents)&&finiteNonnegative(d.payrollTaxCents));
  const payrollCoveredDays=payrollDays.length;
  const payrollCents=payrollDays.reduce((n,d)=>n+d.wagesCents+d.payrollTaxCents,0);
  // Less than 7 independently evidenced payroll days are insufficient to
  // project a month. Never silently divide by the sales-covered denominator.
  const monthlyPayrollCents=payrollCoveredDays>=7?
    Math.round(payrollCents*30/payrollCoveredDays):null;
  const payrollStatus:MenuPriceSourceBasis["payrollStatus"]=
    monthlyPayrollCents===null?"missing":
      payrollDays.every(d=>d.payrollTaxStatus==="actual")?"projected":"estimated";

  const feeSales=days.filter(d=>d.netSalesCents>0);
  const feeReady=coveredDays>=7&&feeSales.length>0&&
    feeSales.every(d=>d.cardFeesStatus==="actual"||d.cardFeesStatus==="estimated");
  const revenue=feeSales.reduce((n,d)=>n+d.netSalesCents,0);
  const cardFees=feeSales.reduce((n,d)=>n+d.cardFeesCents,0);
  const processingFeeBps=feeReady&&revenue>0&&cardFees>=0?
    Math.round(10000*cardFees/revenue):null;

  const monthlyPrepSeconds=monthlyDrinks!==null&&
    Number.isSafeInteger(input.totalItemPrepSecondsInWindow)&&
    input.totalItemPrepSecondsInWindow>0
    ?Math.round(input.totalItemPrepSecondsInWindow*scale):null;
  return {monthlyRunningCents,runningStatus,monthlyPayrollCents,payrollStatus,
    monthlyDrinks,volumeStatus:monthlyDrinks===null?"missing":"projected",
    processingFeeBps,feeStatus:processingFeeBps===null?"missing":
      feeSales.every(d=>d.cardFeesStatus==="actual")?"actual":"estimated",
    monthlyPrepSeconds,coveredDays,
    oldestDate:days[0]?.businessDate??null,
    latestDate:days[days.length-1]?.businessDate??null,
    payrollCoveredDays,payrollOldestDate:payrollDays[0]?.businessDate??null,
    payrollLatestDate:payrollDays[payrollDays.length-1]?.businessDate??null};
}
