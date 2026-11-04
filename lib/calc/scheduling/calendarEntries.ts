/** One calendar projection: Toast is authoritative by café-local date.
 * An approved Olivia revision is still a plan, not evidence of work.
 */
export type CalendarEntry={
 id:string;employeeId:string|null;employeeName:string;locationId?:string|null;
 date:string;endDate?:string;start:string;end:string;
 source:"toast_planned"|"toast_actual"|"ai_draft";
};
export function toastCalendarDates(entries:readonly CalendarEntry[]):Set<string>{
 const toastDays=new Set<string>();
 for(const entry of entries.filter(e=>e.source!=="ai_draft")){
  toastDays.add(entry.date);
  // An overnight Toast shift also owns the next café-local day.
  if(entry.endDate&&entry.endDate>entry.date){
   let date=entry.date;
   for(let i=0;i<3&&date<entry.endDate;i++){
    date=new Date(Date.parse(date+"T12:00:00Z")+86400000).toISOString().slice(0,10);
    toastDays.add(date);
   }
  }
 }
 return toastDays;
}
export function reconcileStaffCalendar(entries:readonly CalendarEntry[]):CalendarEntry[]{
 const toastDays=toastCalendarDates(entries);
 return entries.filter(e=>e.source!=="ai_draft"||!toastDays.has(e.date))
  .sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||
    a.employeeName.localeCompare(b.employeeName)||a.id.localeCompare(b.id));
}

/** Display-only rows for Toast workers without an app employee link.
 * Never turn these placeholders into writable scheduling identities.
 */
export function calendarDisplayRows<P extends {id:string;name:string}>(
 people:readonly P[], entries:readonly CalendarEntry[]
):Array<{key:string;person:P|null;name:string}>{
 const rows=people.map(person=>({key:person.id,person,name:person.name}));
 const known=new Set(people.map(p=>p.id));
 const extras=new Map<string,string>();
 for(const entry of entries){
  if(entry.employeeId&&known.has(entry.employeeId))continue;
  const key="toast-unlinked:"+(entry.employeeId??entry.employeeName);
  if(!extras.has(key))extras.set(key,entry.employeeName);
 }
 return [...rows,...[...extras].map(([key,name])=>({key,person:null,name}))];
}
export function calendarRowKey(entry:CalendarEntry,knownIds:ReadonlySet<string>):string{
 return entry.employeeId&&knownIds.has(entry.employeeId)?
  entry.employeeId:"toast-unlinked:"+(entry.employeeId??entry.employeeName);
}
