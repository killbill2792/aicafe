import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {CanonicalFinancialPeriod,FinancialPeriodKey} from "./types";

const keys:FinancialPeriodKey[]=["today","week","month","previous_today","previous_week","previous_month"];
export async function readFinancialPeriods(db:SupabaseClient,businessId:string,asOf?:string):Promise<Record<FinancialPeriodKey,CanonicalFinancialPeriod>>{
 const {data,error}=asOf?await db.rpc("financial_periods_as_of",{p_business_id:businessId,p_as_of:asOf}):
   await db.from("cv_financial_periods").select("period_key,data").eq("business_id",businessId);
 if(error)throw error;
 if(!Array.isArray(data)||data.length!==keys.length)throw Error("financial_period_source_incomplete");
 const out=Object.fromEntries(data.map(row=>[row.period_key,row.data])) as Record<FinancialPeriodKey,CanonicalFinancialPeriod>;
 for(const k of keys){
  const p=out[k];
  if(!p||![p.netSalesCents,p.ingredientsCents,p.wagesCents,p.staffTaxCents,p.feesCents,p.billsCents,p.ownerPayrollExtrasCents,p.knownLaborCents,p.totalCostsCents,p.coveredSalesDays,p.coveredLaborDays,p.expectedDays].every(Number.isSafeInteger)||
    (p.profitCents!==null&&!Number.isSafeInteger(p.profitCents)))throw Error("financial_period_source_incomplete");
 }
 return out;
}
