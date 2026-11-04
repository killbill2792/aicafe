/** One calendar projection: Toast is authoritative by café-local date.
 * An approved Olivia revision is still a plan, not evidence of work.
 */
export type CalendarEntry={
 id:string;employeeId:string|null;employeeName:string;
 date:string;start:string;end:string;
 source:"toast_planned"|"toast_actual"|"ai_draft";
};
export function reconcileStaffCalendar(entries:readonly CalendarEntry[]):CalendarEntry[]{
 const toastDays=new Set(entries.filter(e=>e.source!=="ai_draft").map(e=>e.date));
 return entries.filter(e=>e.source!=="ai_draft"||!toastDays.has(e.date))
  .sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||
    a.employeeName.localeCompare(b.employeeName)||a.id.localeCompare(b.id));
}
