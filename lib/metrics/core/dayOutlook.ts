/** "What does a day like this usually bring?" from the café's own closed days.
 * Pure and integer-only: money stays in cents, percents are whole numbers.
 * Used by the nearby-events chat tool; any screen that shows the same outlook
 * must call these functions, never its own copy. */

export type OutlookSalesDay={date:string;netSalesCents:number};
export type TypicalDaySales={typicalCents:number|null;sampleDays:number;from:string;to:string};
export type LastTimeOutlook={date:string;netSalesCents:number;typicalCents:number;changePercent:number;sampleDays:number};

/** Fewer same-weekday days than this is not a "usual" day. */
export const MIN_TYPICAL_SAMPLE=3;

const weekday=(date:string)=>new Date(date+"T00:00:00Z").getUTCDay();
function shift(date:string,days:number):string{
  const t=new Date(date+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+days);return t.toISOString().slice(0,10);
}
/** Median in whole cents (an even count rounds the middle pair half up). */
export function medianCents(values:readonly number[]):number|null{
  if(!values.length)return null;
  const s=[...values].sort((a,b)=>a-b),mid=Math.floor(s.length/2);
  return s.length%2?s[mid]:Math.round((s[mid-1]+s[mid])/2);
}

/** Median sales of the same weekday as `target` over the `weeks` weeks before
 * `before` (exclusive), leaving out holidays/event days in `exclude`. */
export function typicalDaySales(days:readonly OutlookSalesDay[],target:string,before:string,
  options:{weeks?:number;exclude?:ReadonlySet<string>}={}):TypicalDaySales{
  const weeks=options.weeks??8;
  const from=shift(before,-weeks*7),to=shift(before,-1),want=weekday(target);
  const values=days.filter(d=>d.date>=from&&d.date<=to&&weekday(d.date)===want&&
    !options.exclude?.has(d.date)&&Number.isSafeInteger(d.netSalesCents)&&d.netSalesCents>=0)
    .map(d=>d.netSalesCents);
  return {typicalCents:values.length>=MIN_TYPICAL_SAMPLE?medianCents(values):null,sampleDays:values.length,from,to};
}

/** Whole-percent change of `actualCents` against `typicalCents`; null when there is no base. */
export function changePercent(actualCents:number,typicalCents:number):number|null{
  if(!Number.isSafeInteger(actualCents)||!Number.isSafeInteger(typicalCents)||typicalCents<=0)return null;
  return Math.round((actualCents-typicalCents)*100/typicalCents);
}

/** How a past occurrence (e.g. last year's Halloween) compared with the usual
 * same weekday in the 6 weeks before it. Null when that day or its base is missing. */
export function lastTimeOutlook(days:readonly OutlookSalesDay[],pastDate:string,
  exclude:ReadonlySet<string>=new Set()):LastTimeOutlook|null{
  const day=days.find(d=>d.date===pastDate);
  if(!day||!Number.isSafeInteger(day.netSalesCents))return null;
  const base=typicalDaySales(days,pastDate,pastDate,{weeks:6,exclude});
  if(base.typicalCents===null)return null;
  const change=changePercent(day.netSalesCents,base.typicalCents);
  if(change===null)return null;
  return {date:pastDate,netSalesCents:day.netSalesCents,typicalCents:base.typicalCents,
    changePercent:change,sampleDays:base.sampleDays};
}

/** Same-weekday hourly medians from the existing canonical hourly POS reader.
 * Multiple locations in a day/hour are summed before taking the median.
 * Missing hours stay unknown: they must never be converted to observed zero. */
export type OutlookHour={hourLocal:number;typicalCents:number;sampleDays:number};
export type OutlookHourlyRow={date:string;hourLocal:number;netSalesCents:number};
export function typicalHourlySales(rows:readonly OutlookHourlyRow[],target:string,before:string,
  options:{weeks?:number;exclude?:ReadonlySet<string>}={}):OutlookHour[]{
  const from=shift(before,-(options.weeks??8)*7),to=shift(before,-1),want=weekday(target);
  const perDayHour=new Map<string,number>();
  for(const row of rows){
    if(row.date<from||row.date>to||weekday(row.date)!==want||options.exclude?.has(row.date)||
       !Number.isInteger(row.hourLocal)||row.hourLocal<0||row.hourLocal>23||
       !Number.isSafeInteger(row.netSalesCents)||row.netSalesCents<0)continue;
    const key=row.date+"|"+row.hourLocal;
    const next=(perDayHour.get(key)??0)+row.netSalesCents;
    if(Number.isSafeInteger(next))perDayHour.set(key,next);
  }
  const byHour=new Map<number,number[]>();
  for(const [key,value] of perDayHour){
    const hour=Number(key.split("|")[1]);
    if(!Number.isInteger(hour))continue;
    byHour.set(hour,[...(byHour.get(hour)??[]),value]);
  }
  return [...byHour].flatMap(([hourLocal,values])=>
    values.length>=MIN_TYPICAL_SAMPLE?[{hourLocal,typicalCents:medianCents(values)!,sampleDays:values.length}]:[])
    .sort((a,b)=>a.hourLocal-b.hourLocal);
}
