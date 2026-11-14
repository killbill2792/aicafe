import type {Hour} from "@/lib/data/posFactReaders.server";
import {civilDateAdd, weekday} from "./plannerClock";

/** Source-backed *historical* hourly observations. A close-hour sales rollup
 * is not arrival-rate evidence and never supplies an automatic staff count. */
export type ComparableDemandHour={
  targetDate:string;hourLocal:number;locationId:string|null;
  observedAverageOrders:number;observedAverageNetSalesCents:number;
  sampleDays:string[];
};
export type ScheduleDemandEvidence={
  status:"available"|"partial"|"unavailable";
  source:"hourly_sales_rollup";
  basis:"observed_comparable_weekday_close_hours";
  targetWeekStart:string;
  historicalPeriod:{from:string;to:string};
  readAt:string;
  sourceUpdatedAt:null;
  /** Total qualified comparable hours before the bounded presentation cap. */
  totalComparableHours:number;
  truncated:boolean;
  hours:ComparableDemandHour[];
  missing:string[];
};

type Inputs={
  targetWeekStart:string;
  historicalPeriod:{from:string;to:string};
  hours:readonly Hour[];
  missing:readonly string[];
  stale:readonly string[];
  readAt:string;
};
export function unavailableScheduleDemand(input:Pick<Inputs,"targetWeekStart"|"historicalPeriod"|"readAt">,missing:string[]):ScheduleDemandEvidence{
  return {status:"unavailable",source:"hourly_sales_rollup",
    basis:"observed_comparable_weekday_close_hours",
    targetWeekStart:input.targetWeekStart,historicalPeriod:input.historicalPeriod,
    readAt:input.readAt,sourceUpdatedAt:null,totalComparableHours:0,
    truncated:false,hours:[],missing};
}
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const validDate=(d:string)=>datePattern.test(d)&&!Number.isNaN(Date.parse(d+"T12:00:00Z"))&&
  new Date(d+"T12:00:00Z").toISOString().slice(0,10)===d;

/** Pure calculation; never upgrades incomplete source facts into a forecast.
 * Every displayed average retains its exact contributing source dates. */
export function comparableDemandHours(input:Inputs):ScheduleDemandEvidence{
  const shell={targetWeekStart:input.targetWeekStart,historicalPeriod:input.historicalPeriod,readAt:input.readAt};
  if(!validDate(input.targetWeekStart)||!validDate(input.historicalPeriod.from)||
    !validDate(input.historicalPeriod.to)||input.historicalPeriod.from>input.historicalPeriod.to)
    return unavailableScheduleDemand(shell,["invalidDemandPeriod"]);
  // The canonical POS reader reports missing dates when a source emits no
  // hourly rows. Those dates are UNKNOWN, never an inferred zero. Real,
  // independently observed comparable days may still be shown as PARTIAL.
  // A stale, failed or uncertified import cannot support a trusted average.
  const noObservedDate=input.missing.filter(m=>m==="hourlySalesDatesNotObserved");
  const blocking=[...input.missing.filter(m=>m!=="hourlySalesDatesNotObserved"),...input.stale];
  if(blocking.length)return unavailableScheduleDemand(shell,[...new Set(blocking)]);
  if(!input.hours.length)return unavailableScheduleDemand(shell,["noHourlySalesFacts"]);
  const unique=new Set<string>();
  const groups=new Map<string,Hour[]>();
  for(const hour of input.hours){
    if(!validDate(hour.date)||hour.date<input.historicalPeriod.from||
      hour.date>input.historicalPeriod.to||!Number.isSafeInteger(hour.hourLocal)||
      hour.hourLocal<0||hour.hourLocal>23||
      (hour.locationId!==null&&(typeof hour.locationId!=="string"||hour.locationId.length===0))||
      !Number.isSafeInteger(hour.ordersCount)||hour.ordersCount<0||
      !Number.isSafeInteger(hour.netSalesCents))
      return unavailableScheduleDemand(shell,["unsafeHourlySalesFacts"]);
    // The historical rollup has no guaranteed unique constraint for location/hour.
    // A duplicate is ambiguous: do not silently add or arbitrarily choose a row.
    const key=JSON.stringify([hour.date,hour.locationId,hour.hourLocal]);
    if(unique.has(key))return unavailableScheduleDemand(shell,["ambiguousDuplicateHourlyFact"]);
    unique.add(key);
    const group=JSON.stringify([weekday(hour.date),hour.locationId,hour.hourLocal]);
    groups.set(group,[...(groups.get(group)??[]),hour]);
  }
  const context:ComparableDemandHour[]=[];
  for(let offset=0;offset<7;offset++){
    const targetDate=civilDateAdd(input.targetWeekStart,offset);
    const day=weekday(targetDate);
    for(const [key,rows] of groups){
      const [dayOfWeek,locationId,hourLocal] = JSON.parse(key) as [number,string|null,number];
      if(dayOfWeek!==day||rows.length<2)continue;
      const sorted=[...rows].sort((a,b)=>a.date.localeCompare(b.date));
      const average=(value:(r:Hour)=>number)=>{
        const sum=sorted.reduce((n,r)=>n+value(r),0);
        return Number.isSafeInteger(sum)?Math.round(sum/sorted.length):null;
      };
      const observedAverageOrders=average(r=>r.ordersCount);
      const observedAverageNetSalesCents=average(r=>r.netSalesCents);
      if(observedAverageOrders===null||observedAverageNetSalesCents===null)
        return unavailableScheduleDemand(shell,["unsafeHourlySalesSum"]);
      context.push({targetDate,hourLocal,locationId,observedAverageOrders,
        observedAverageNetSalesCents,sampleDays:sorted.map(r=>r.date)});
    }
  }
  if(!context.length)return unavailableScheduleDemand(shell,["insufficientComparableHourSamples"]);
  const totalComparableHours=context.length;
  // Presentation budget, NOT a café staffing threshold. Prioritize actual
  // observed peak hours, report omissions and never use this subset as totals.
  const MAX_PRESENTED_HOURS=80;
  context.sort((a,b)=>b.observedAverageOrders-a.observedAverageOrders||
    a.targetDate.localeCompare(b.targetDate)||a.hourLocal-b.hourLocal||
    (a.locationId??"").localeCompare(b.locationId??""));
  const truncated=context.length>MAX_PRESENTED_HOURS;
  const presented=context.slice(0,MAX_PRESENTED_HOURS);
  presented.sort((a,b)=>a.targetDate.localeCompare(b.targetDate)||
    a.hourLocal-b.hourLocal||(a.locationId??"").localeCompare(b.locationId??""));
  return {status:noObservedDate.length?"partial":"available",source:"hourly_sales_rollup",
    basis:"observed_comparable_weekday_close_hours",
    targetWeekStart:input.targetWeekStart,historicalPeriod:input.historicalPeriod,
    readAt:input.readAt,sourceUpdatedAt:null,totalComparableHours,truncated,
    hours:presented,missing:[...new Set([...noObservedDate,...(truncated?["comparableHourResultTruncated"]:[])])]} ;
}
