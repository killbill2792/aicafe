/** Single source for owner-facing Toast monetary comparison.
 * A changed checksum alone is information, NOT a financial mismatch. */
export const DAY_CHECK_TOLERANCE_CENTS=1;
export const DAY_MONEY_FIELDS=["net_sales_cents","discounts_cents","refunds_cents","tax_cents","tip_cents"] as const;
export type DayMoneyField=typeof DAY_MONEY_FIELDS[number];
export type DayMoney=Partial<Record<DayMoneyField,number|null>>;
export type DayCheckResult={matched:boolean;needsLook:boolean;reasons:string[];
 missing:DayMoneyField[];differences:Partial<Record<DayMoneyField,number>>;
 toastNetSalesCents:number|null};
export function compareDayMoney(ours:DayMoney,toast:DayMoney):DayCheckResult{
 const reasons:string[]=[];const missing:DayMoneyField[]=[];
 const differences:Partial<Record<DayMoneyField,number>>={};
 for(const key of DAY_MONEY_FIELDS){
  const a=ours[key],b=toast[key];
  if(a==null||b==null||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)){
   missing.push(key);continue;
  }
  const delta=b-a;
  differences[key]=delta;
  if(Math.abs(delta)>DAY_CHECK_TOLERANCE_CENTS)
   reasons.push(key+"_delta_"+delta+"_cents");
 }
 return {matched:reasons.length===0&&missing.length===0,
  needsLook:reasons.length>0,reasons,missing,differences,
  toastNetSalesCents:Number.isSafeInteger(toast.net_sales_cents)?toast.net_sales_cents!:null};
}
