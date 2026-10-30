/** Central owner-question catalog. Unknown tool missing keys get a text question. */
export type FactType="number"|"money"|"percent"|"text"|"date"|"choice";
export type FactTarget="owner_facts"|"recurring_costs"|"processing_fee_rate_plans"|"businesses";
export type FactDefinition={factKey:string;type:FactType;labelKey:string;target:FactTarget};
const entries:Record<string,FactDefinition>={
  milk_base_type:{factKey:"milk_base_type",type:"text",labelKey:"milkBase",target:"owner_facts"},
  milk_target_type:{factKey:"milk_target_type",type:"text",labelKey:"milkTarget",target:"owner_facts"},
  monthly_payroll_cents:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  monthly_bills_cents:{factKey:"monthly_bills_cents",type:"money",labelKey:"bills",target:"recurring_costs"},
  card_fee_rate_percent:{factKey:"card_fee_rate_percent",type:"percent",labelKey:"cardFee",target:"processing_fee_rate_plans"},
  card_sales_share_percent:{factKey:"card_sales_share_percent",type:"percent",labelKey:"cardSalesShare",target:"processing_fee_rate_plans"},
  card_transactions_share_percent:{factKey:"card_transactions_share_percent",type:"percent",labelKey:"cardTransactionsShare",target:"processing_fee_rate_plans"},
  card_fixed_fee_cents:{factKey:"card_fixed_fee_cents",type:"money",labelKey:"cardFixedFee",target:"processing_fee_rate_plans"},
  card_average_ticket_cents:{factKey:"card_average_ticket_cents",type:"money",labelKey:"averageTicket",target:"processing_fee_rate_plans"},
  card_processor_label:{factKey:"card_processor_label",type:"text",labelKey:"processor",target:"processing_fee_rate_plans"},
  payroll_extras_monthly_cents:{factKey:"payroll_extras_monthly_cents",type:"money",labelKey:"payrollExtras",target:"businesses"},
  ingredient_cost_percent_of_sales:{factKey:"ingredient_cost_percent_of_sales",type:"percent",labelKey:"ingredientPercent",target:"owner_facts"},
  unit_cost_cents:{factKey:"unit_cost_cents",type:"money",labelKey:"itemCost",target:"owner_facts"},
  payroll:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  payrollMissing:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  laborMissing:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  laborCents:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  monthlyStaff:{factKey:"monthly_payroll_cents",type:"money",labelKey:"payroll",target:"owner_facts"},
  owner_monthly_bills_cents:{factKey:"monthly_bills_cents",type:"money",labelKey:"bills",target:"recurring_costs"},
  monthlyBills:{factKey:"monthly_bills_cents",type:"money",labelKey:"bills",target:"recurring_costs"},
  bills:{factKey:"monthly_bills_cents",type:"money",labelKey:"bills",target:"recurring_costs"},
  overhead:{factKey:"monthly_bills_cents",type:"money",labelKey:"bills",target:"recurring_costs"},
  cardFeeRate:{factKey:"card_fee_rate_percent",type:"percent",labelKey:"cardFee",target:"processing_fee_rate_plans"},
  processingFees:{factKey:"card_fee_rate_percent",type:"percent",labelKey:"cardFee",target:"processing_fee_rate_plans"},
  payrollExtras:{factKey:"payroll_extras_monthly_cents",type:"money",labelKey:"payrollExtras",target:"businesses"},
  unitCostCents:{factKey:"unit_cost_cents",type:"money",labelKey:"itemCost",target:"owner_facts"},
  ingredientCost:{factKey:"ingredient_cost",type:"money",labelKey:"itemCost",target:"owner_facts"},
  openingHours:{factKey:"opening_hours",type:"text",labelKey:"hours",target:"owner_facts"},
  schedule:{factKey:"schedule",type:"text",labelKey:"schedule",target:"owner_facts"},
  shifts:{factKey:"schedule",type:"text",labelKey:"schedule",target:"owner_facts"},
  get_schedule:{factKey:"schedule",type:"text",labelKey:"schedule",target:"owner_facts"},
  get_week_schedule:{factKey:"schedule",type:"text",labelKey:"schedule",target:"owner_facts"},
  suggest_new_item_price:{factKey:"unit_cost_cents",type:"money",labelKey:"itemCost",target:"owner_facts"},
};
export function catalogForMissing(key:string):FactDefinition{
  if(/^schedule:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(key))
    return {factKey:key,type:"text",labelKey:"schedule",target:"owner_facts"};
  if(/^unit_cost_cents:item:(?:[a-zA-Z0-9_-]{1,64})$/.test(key))
    return {factKey:key,type:"money",labelKey:"itemCost",target:"owner_facts"};
  if(key==="milk_requested_size")
    return {factKey:key,type:"text",labelKey:"milkNoSize",target:"owner_facts"};
  if(/^milk_ml:[0-9]{1,2}oz$/.test(key))
    return {factKey:key,type:"number",labelKey:"milkVolume",target:"owner_facts"};
  if(/^milk_base_serving_cost_cents:[0-9]{1,2}oz$/.test(key))
    return {factKey:key,type:"money",labelKey:"milkBaseCost",target:"owner_facts"};
  if(/^milk_[a-z0-9_]{1,60}_serving_cost_cents:[0-9]{1,2}oz$/.test(key))
    return {factKey:key,type:"money",labelKey:"milkTargetCost",target:"owner_facts"};
  const normalized=key.replace(/[^a-zA-Z0-9_.:-]/gu,"_");
  const factKey=/^[a-zA-Z]/.test(normalized)?normalized.slice(0,120):"fact_"+normalized.slice(0,115);
  return entries[key]??{factKey:factKey||"unknown_fact",
    type:"text",labelKey:"generic",target:"owner_facts"};
}
