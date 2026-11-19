/** Shared labels and routing for persisted, source-backed business observations. */
export const businessSignalTitles={
 sales_decline:"Sales declined",live_sales_decline:"Live sales running behind usual pace",live_sales_growth:"Live sales ahead of usual pace",sales_growth:"Sales growth opportunity",labor_cost:"Recorded wage cost changed",
 recorded_expense_rise:"Recorded expenses increased",recorded_refund_rise:"Recorded refunds increased",order_refund_rise:"Verified order-date refunds increased",ingredient_cost:"Ingredient unit cost increased",
 stock_shortage:"Counted stock depleted",stockout_risk:"Possible stockout based on recent usage",
 consumption_variance:"Ingredient consumption above recipe expectation",supplier_quote:"Supplier quote unit cost increased",
 product_cost:"Current recipe cost changed",product_contribution:"Current recipe contribution fell",
 high_contribution:"High-contribution product opportunity",operating_margin:"Operating margin declined",cost_recovery_lag:"Monthly cost recovery behind last month",cost_recovery_ahead:"Monthly cost recovery ahead of last month",
 overstaffed_hour:"Repeated high staffing cost relative to hourly sales",early_clock_in:"Actual clock-in before published shift",missed_clock_evidence:"Published shift clock-in evidence missing",data_gap:"Business evidence needs attention",
} as const;
export type BusinessSignal=keyof typeof businessSignalTitles;
export function businessSignalTitle(v:unknown):string{return typeof v==="string"&&Object.hasOwn(businessSignalTitles,v)?businessSignalTitles[v as BusinessSignal]:"Business observation needs review";}
