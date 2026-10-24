/** Shared and validated schedule deep links across Alerts, Home and Operations. */
export function validScheduleDate(value:unknown):value is string {
 if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+"T12:00:00Z");
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function scheduleWeekForDate(date:unknown,week:unknown,fallback:string):string {
 const input=validScheduleDate(date)?date:validScheduleDate(week)?week:fallback;
 const day=new Date(input+"T12:00:00Z");
 const dow=day.getUTCDay();
 day.setUTCDate(day.getUTCDate()-((dow+6)%7));
 return day.toISOString().slice(0,10);
}
export function staffScheduleHref(input:{date?:unknown;employee?:unknown}):string {
 const query=new URLSearchParams({tab:"schedule"});
 if(validScheduleDate(input.date))query.set("date",input.date);
 if(typeof input.employee==="string"&&input.employee.trim())query.set("employee",input.employee);
 return "/staff?"+query.toString();
}

/** Legacy Staff URLs retain employee/date and explicit Schedule tabs. */
export function staffManageRedirectQuery(input:{employee?:string;date?:string;tab?:string}){
 return {tab:validScheduleDate(input.date)||input.tab==="schedule"?"schedule" as const:"team" as const,
  ...(input.employee?{employee:input.employee}:{}),
  ...(validScheduleDate(input.date)?{date:input.date}:{})};
}

/** Resolve only the requested member's dated shift. Do not guess a different shift
 * when a timecard's start time does not match the schedule. */
export function resolveDatedStaffShift<P extends {id:string},S extends {id:string;employeeId:string;date:string;start:string}>(
 dates:readonly string[],team:readonly P[],shifts:readonly S[],date:unknown,employee:unknown,clock?:string
):{date:string;person:P;shift:S|undefined}|null{
 if(!validScheduleDate(date)||!dates.includes(date)||typeof employee!=="string")return null;
 const person=team.find(p=>p.id===employee);
 if(!person)return null;
 const shift=shifts.find(s=>s.employeeId===person.id&&s.date===date&&(!clock||s.start===clock));
 return {date,person,shift};
}
