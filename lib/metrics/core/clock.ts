/** Business-calendar dates: always resolve an instant in the café's configured IANA zone. */
export type CafeRange = {from:string;to:string};
export type CafeRangeRequest = CafeRange | {
  preset:"today"|"yesterday"|"this_month"|"last_month"|"last_28_complete_days";
  now?:Date;
};
function assertDate(value:string):void {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new RangeError("Invalid business date");
  const date=new Date(value+"T12:00:00Z");
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)
    throw new RangeError("Invalid business date");
}
/** Date-only arithmetic is UTC-independent: the timezone conversion happens only in cafeToday. */
export function shiftCafeDate(day:string,offset:number):string {
  assertDate(day);
  const d=new Date(day+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()+offset);
  return d.toISOString().slice(0,10);
}
export function cafeToday(timezone:string,now:Date=new Date()):string {
  if(!timezone?.trim())throw new RangeError("Café timezone is required");
  if(!Number.isFinite(now.getTime()))throw new RangeError("Invalid current time");
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(now);
  const value=(part:string)=>parts.find(p=>p.type===part)?.value;
  const day=`${value("year")}-${value("month")}-${value("day")}`;
  assertDate(day);
  return day;
}
export function cafeDayRange(timezone:string,period:CafeRangeRequest):CafeRange {
  // Validate the timezone even for explicit date ranges: a missing café zone is never silently UTC.
  cafeToday(timezone,period && "now" in period?period.now:new Date());
  if("from" in period){
    assertDate(period.from);assertDate(period.to);
    if(period.from>period.to)throw new RangeError("Reversed business date range");
    return {from:period.from,to:period.to};
  }
  const today=cafeToday(timezone,period.now);
  if(period.preset==="today")return {from:today,to:today};
  if(period.preset==="yesterday"){
    const day=shiftCafeDate(today,-1);return {from:day,to:day};
  }
  if(period.preset==="last_28_complete_days")return {
    from:shiftCafeDate(today,-28),to:shiftCafeDate(today,-1),
  };
  if(period.preset==="this_month")return {from:today.slice(0,7)+"-01",to:today};
  if(period.preset==="last_month"){
    const last=shiftCafeDate(today.slice(0,7)+"-01",-1);
    return {from:last.slice(0,7)+"-01",to:last};
  }
  throw new RangeError("Unsupported period");
}
