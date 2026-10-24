/** Shared and validated schedule deep links across Alerts, Home and Operations. */
export function validScheduleDate(value:unknown):value is string {
 if(typeof value!=="string"||!/^(?:\\d{4})-(?:\\d{2})-(?:\\d{2})$/.test(value))return false;
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
