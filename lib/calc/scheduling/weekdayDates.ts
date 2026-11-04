/** Shared civil-date utilities; no draft scheduler lives here. */
const addDays=(date:string,n:number)=>new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export function nextMonday(asOf:string){
 const weekday=new Date(asOf+"T12:00:00Z").getUTCDay();
 return addDays(asOf,(8-weekday)%7||7);
}
export function businessLocalDate(now:Date,timezone:string){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,
  year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
 const p=(type:string)=>parts.find(v=>v.type===type)?.value??"";
 return p("year")+"-"+p("month")+"-"+p("day");
}
