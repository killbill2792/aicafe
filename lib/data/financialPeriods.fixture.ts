// Synthetic transport fixtures; migrated SQL is tested separately.
export function fixtureFinancialPeriodRows(){
 return ["today","week","month","previous_today","previous_week","previous_month"].map(period_key=>({period_key,data:{
  netSalesCents:0,ingredientsCents:0,wagesCents:0,staffTaxCents:0,feesCents:0,billsCents:0,ownerPayrollExtrasCents:0,knownLaborCents:0,
  totalCostsCents:0,profitCents:null,coveredSalesDays:0,coveredLaborDays:0,expectedDays:1,unknownLabor:false,estimatedLabor:false,
 }}));
}
