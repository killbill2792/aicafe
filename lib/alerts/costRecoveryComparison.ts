import type {BusinessSnapshot} from "@/lib/data/types";
import {computeCostRecovery} from "@/lib/calc/costRecovery";
import {dayContributionCents,recoveryBuckets} from "@/lib/viewmodels/costRecoveryShared";
type Period={from:string;to:string};
/** Explicit actuals only; missing source days, fees and payroll never become zeros. */
export function verifiedPeriodDays(snapshot:BusinessSnapshot,period:Period){
 const days=[...(snapshot.previousMonthDays??[]),...(snapshot.monthActualDays??[])].filter(d=>d.date>=period.from&&d.date<=period.to).sort((a,b)=>a.date.localeCompare(b.date));
 const count=(Date.parse(period.to)-Date.parse(period.from))/86400000+1;
 if(count<1||days.length!==count||new Set(days.map(d=>d.date)).size!==count||days.some(d=>d.salesDataStatus!=="actual"||d.laborWageStatus!=="actual"||d.staffTaxStatus!=="actual"||d.cardFeesStatus!=="actual"||![d.netSalesCents,d.ingredientsCents,d.wagesCents,d.staffTaxCents,d.cardFeesCents].every(n=>typeof n==="number"&&Number.isFinite(n))))return null;
 return days;
}
export function comparableRecoveryPeriods(today:string):{current:Period;previous:Period}|null{
 const [year,month,date]=today.split("-").map(Number);
 const previous=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
 const elapsed=Math.min(date-1,new Date(Date.UTC(year,month-1,0)).getUTCDate());
 if(elapsed<1)return null;
 const n=String(elapsed).padStart(2,"0"),current=today.slice(0,7);
 return {current:{from:current+"-01",to:current+"-"+n},previous:{from:previous+"-01",to:previous+"-"+n}};
}
/** Same canonical sequential recovery algorithm as the owner UI; no projected days. */
export function verifiedRecoveryRatio(snapshot:BusinessSnapshot,period:Period):number|null{
 const days=verifiedPeriodDays(snapshot,period);
 if(!days||snapshot.monthKey!==period.from.slice(0,7)||snapshot.runningCostLines.some(l=>l.isExpected&&(l.isMissing||l.isEstimate)))return null;
 const buckets=recoveryBuckets(snapshot);
 const total=buckets.reduce((n,b)=>n+b.amountCents,0);
 if(total<=0||buckets.some(b=>b.isEstimate))return null;
 const contributions=days.map(d=>({date:d.date,cents:dayContributionCents(d),projected:false}));
 if(contributions.some(d=>d.cents===null))return null;
 const result=computeCostRecovery(buckets,contributions.map(d=>({...d,cents:d.cents!})));
 return result.buckets.reduce((n,b)=>n+b.amountCents-b.centsToGo,0)/total;
}
