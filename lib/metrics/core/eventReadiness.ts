import {typicalDaySales,changePercent,type OutlookSalesDay} from "./dayOutlook";
/** All event-day hourly money aggregation stays in the canonical metrics layer. */
export type HourRevenue={date:string;hourLocal:number;netSalesCents:number};
export function indexHourlyRevenue(rows:readonly HourRevenue[]):Map<string,Map<number,number>>{
 const days=new Map<string,Map<number,number>>();
 for(const row of rows){
  if(!Number.isSafeInteger(row.netSalesCents)||!Number.isInteger(row.hourLocal)||
    row.hourLocal<0||row.hourLocal>23)throw new Error("Invalid hourly sales fact");
  const byHour=days.get(row.date)??new Map<number,number>();
  const cents=(byHour.get(row.hourLocal)??0)+row.netSalesCents;
  if(!Number.isSafeInteger(cents))throw new Error("Hourly money exceeds safe integer cents");
  byHour.set(row.hourLocal,cents);
  days.set(row.date,byHour);
 }
 return days;
}
export function hourlyMatchesDaily(rows:ReadonlyMap<number,number>|undefined,dailyCents:number):boolean{
 if(!rows||!Number.isSafeInteger(dailyCents))return false;
 let total=0;
 for(const cents of rows.values()){
  total+=cents;
  if(!Number.isSafeInteger(total))return false;
 }
 return total===dailyCents;
}

/** The saved event report and upcoming-events outlook use the SAME canonical
 * same-weekday, eight-week, minimum-sample and nonnegative-sales rules.
 * Historical hours missing their daily reconciliation are omitted ONLY from
 * hourly comparisons: they never change the daily usual-day figure. */
export function compareEventDaySales(
 certifiedDays:readonly OutlookSalesDay[],
 hourlyByDate:ReadonlyMap<string,ReadonlyMap<number,number>>,
 businessDate:string,excluded:ReadonlySet<string>,
){
 const actual=certifiedDays.find(day=>day.date===businessDate);
 if(!actual||!hourlyMatchesDaily(hourlyByDate.get(businessDate),actual.netSalesCents))
   return null;
 const typical=typicalDaySales(certifiedDays,businessDate,businessDate,{exclude:excluded});
 const hourlyCovered=certifiedDays.filter(day=>
   hourlyMatchesDaily(hourlyByDate.get(day.date),day.netSalesCents));
 const observed=hourlyByDate.get(businessDate)!;
 const hours=Array.from({length:24},(_,hourLocal)=>{
   const dailyHour=hourlyCovered.map(day=>({date:day.date,
     netSalesCents:hourlyByDate.get(day.date)?.get(hourLocal)??0}));
   const hourlyTypical=typicalDaySales(dailyHour,businessDate,businessDate,{exclude:excluded});
   const usualCents=hourlyTypical.typicalCents,actualCents=observed.get(hourLocal)??0;
   return {hourLocal,actualCents,usualCents,sampleDays:hourlyTypical.sampleDays,
     changePercent:usualCents===null?null:changePercent(actualCents,usualCents)};
 });
 return {actualCents:actual.netSalesCents,typicalCents:typical.typicalCents,
   changePercent:typical.typicalCents===null?null:changePercent(actual.netSalesCents,typical.typicalCents),
   baselineDays:typical.sampleDays,hours};
}
