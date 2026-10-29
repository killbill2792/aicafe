/** Business-calendar dates: always resolve an instant in the café's configured IANA zone. */
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
