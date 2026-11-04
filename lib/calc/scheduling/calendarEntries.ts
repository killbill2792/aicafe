/** One calendar projection: Toast is authoritative by café-local date.
 * An approved Olivia revision is still a plan, not evidence of work.
 */
export type CalendarEntry={
 id:string;employeeId:string|null;employeeName:string;
 date:string;endDate?:string;start:string;end:string;
 source:"toast_planned"|"toast_actual"|"ai_draft";
};
export function reconcileStaffCalendar(entries:readonly CalendarEntry[]):CalendarEntry[]{
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
 return entries.filter(e=>e.source!=="ai_draft"||!toastDays.has(e.date))
  .sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||
    a.employeeName.localeCompare(b.employeeName)||a.id.localeCompare(b.id));
}
