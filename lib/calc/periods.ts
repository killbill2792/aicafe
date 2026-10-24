/** Pure calendar-day arithmetic. Date-only values always refer to UTC civil dates. */
export type CalcPeriod={from:string;to:string};
const DAY=24*60*60*1000;
function day(value:string):number{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error("Invalid calendar date");
  const n=Date.parse(value+"T00:00:00.000Z");
  if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)throw new Error("Invalid calendar date");
  return n;
}
export function periodDays(period:CalcPeriod):number{
  const days=(day(period.to)-day(period.from))/DAY+1;
  if(days<1||days>3660)throw new Error("Invalid calendar range");
  return days;
}
export function dateOffset(date:string,delta:number):string{
  if(!Number.isSafeInteger(delta))throw new Error("Invalid date offset");
  return new Date(day(date)+delta*DAY).toISOString().slice(0,10);
}
export function requestedPeriod(choice:"today"|"week"|"month",asOf:string):CalcPeriod{
  day(asOf);
  return {from:choice==="today"?asOf:choice==="week"?dateOffset(asOf,-6):asOf.slice(0,7)+"-01",to:asOf};
}
/** Cents/day retains precision until the final rounded financial result. */
export function dailyRate(amountCents:number,period:CalcPeriod):number{
  if(!Number.isSafeInteger(amountCents))throw new Error("Invalid monetary amount");
  return amountCents/periodDays(period);
}
export function prorate(amountCents:number,fromPeriod:CalcPeriod,toPeriod:CalcPeriod){
  return Math.round(dailyRate(amountCents,fromPeriod)*periodDays(toPeriod));
}
export function calendarMonth(date:string):CalcPeriod{
  day(date);
  const start=date.slice(0,7)+"-01";
  const next=new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7)),1));
  return {from:start,to:new Date(next.getTime()-DAY).toISOString().slice(0,10)};
}
export type Coverage=CalcPeriod|readonly string[];
/** Use the requested window if it overlaps actual coverage; otherwise use the
 * most recent covered window (up to the requested length) and tell the owner.
 * A disjoint set of covered days never implies missing days are zero sales. */
export function coveredWindow(requested:CalcPeriod,coverage:Coverage):{
  period:CalcPeriod;fallback:boolean;label:string|null
}{
  const days=Array.isArray(coverage)?[...coverage].sort():null;
  const from=days?days[0]: (coverage as CalcPeriod).from;
  const to=days?days.at(-1): (coverage as CalcPeriod).to;
  if(!from||!to)return {period:requested,fallback:false,label:null};
  day(from);day(to);
  if(from<=requested.to&&to>=requested.from)return {period:requested,fallback:false,label:null};
  const latest={from:dateOffset(to,-Math.min(periodDays(requested),periodDays({from,to}))+1),to};
  const fmt=(v:string)=>{const d=new Date(day(v));return d.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});};
  return {period:latest,fallback:true,label:"Latest data: "+fmt(latest.from)+"–"+fmt(latest.to)};
}
