import type {DailyFacts} from "@/lib/calc";
import {isOverstaffedSlot} from "@/lib/calc/alerts";
import {fromZonedTime} from "date-fns-tz";
import {timecardWagesForInterval,type PricedShift} from "@/lib/pos/timecardDay";
import {hourlyMatchesDaily,indexHourlyRevenue,type HourRevenue} from "@/lib/metrics/core/eventReadiness";

export type ObservedTimecard=PricedShift&{actual:boolean};
const next=(day:string)=>new Date(Date.parse(day+"T12:00:00Z")+86400000).toISOString().slice(0,10);
const hourMs=3600000;
export type StaffPressureSlot={subject:string;highWeeks:number;sampleWeeks:number;active:boolean};
/** Four distinct, consecutive comparable closed weeks. Reconcile hourly
 * sales and allocated paid wages to the day's recorded totals before using a
 * slot. Loaded hourly pay is a derived allocation of the recorded daily tax,
 * NOT a provider-certified hourly payroll expense or proof a shift is unnecessary.
 * DST transition days and unknown/estimated actual wages stay unknown. */
export function hourlyStaffPressure(days:readonly DailyFacts[],hours:readonly HourRevenue[],cards:readonly ObservedTimecard[],timezone:string,now:Date){
 const indexed=indexHourlyRevenue(hours),bySlot=new Map<string,Array<{date:string;ratio:number}>>();
 let coveredDays=0;
 for(const day of days){
  const dailyHours=indexed.get(day.date);
  if(day.salesDataStatus!=="actual"||day.laborWageStatus!=="actual"||day.wagesCents===null||day.wagesCents<0||day.staffTaxCents===null||day.staffTaxCents<0||!day.staffTaxStatus||
     !Number.isFinite(day.wagesCents)||!Number.isFinite(day.staffTaxCents)||!hourlyMatchesDaily(dailyHours,day.netSalesCents))continue;
  const start=fromZonedTime(day.date+"T00:00:00",timezone).getTime(),end=fromZonedTime(next(day.date)+"T00:00:00",timezone).getTime();
  if(!Number.isFinite(start)||end-start!==24*hourMs||end>now.getTime())continue;
  const overlapping=cards.filter(c=>Date.parse(c.clockIn)<end&&(!c.clockOut||Date.parse(c.clockOut)>start));
  if(overlapping.some(c=>!c.actual||!c.clockOut||Date.parse(c.clockOut)>now.getTime()||c.hourlyWageCents===null||!Number.isFinite(c.hourlyWageCents)||c.hourlyWageCents<0))continue;
  const wages=Array.from({length:24},(_,h)=>overlapping.reduce((sum,c)=>sum+timecardWagesForInterval(c,start+h*hourMs,start+(h+1)*hourMs,now)!,0));
  const total=wages.reduce((sum,c)=>sum+c,0);
  if(!Number.isFinite(total)||Math.round(total)!==day.wagesCents||(total===0&&day.staffTaxCents!==0))continue;
  coveredDays++;
  const weekday=new Date(day.date+"T12:00:00Z").getUTCDay();
  for(const [hour,sales] of dailyHours!){
   // A zero/unobserved sales hour has no finite staff-to-sales ratio.
   if(sales<=0)continue;
   const loaded=total===0?0:wages[hour]*(1+day.staffTaxCents/total);
   const ratio=loaded/sales;
   if(!Number.isFinite(ratio))continue;
   const key=weekday+":"+hour;
   bySlot.set(key,[...(bySlot.get(key)??[]),{date:day.date,ratio}]);
  }
 }
 const slots:StaffPressureSlot[]=[];
 for(const [subject,rows] of bySlot){
  const ordered=rows.sort((a,b)=>a.date.localeCompare(b.date));
  if(ordered.length!==4||ordered.slice(1).some((row,i)=>Date.parse(row.date)-Date.parse(ordered[i].date)!==7*86400000))continue;
  const ratios=ordered.map(r=>r.ratio);
  slots.push({subject:"weekday-hour:"+subject,highWeeks:ratios.filter(r=>r>.45).length,sampleWeeks:4,active:isOverstaffedSlot(ratios)});
 }
 return {coveredDays,slots};
}
