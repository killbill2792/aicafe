/** Pure input and summary helpers for the Staff › Team person sheet. No floating-point money. */
export type TeamAvailability = {day:number;start:string|null;end:string|null};

function latinDigits(input:string):string {
 return input.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,character=>{
  const code=character.charCodeAt(0);
  return String(code>=0x6f0?code-0x6f0:code-0x660);
 }).replace(/[\u066b,]/g,".");
}
function decimalInput(input:string):number|undefined {
 const normalized=latinDigits(input.trim());
 if(!/^\d+(?:\.\d{1,6})?$/.test(normalized))return undefined;
 const amount=Number(normalized);
 return Number.isFinite(amount)?amount:undefined;
}
/** null means skipped; undefined means invalid, so invalid entry can never silently become an unknown wage. */
export function parseHourlyWage(input:string):number|null|undefined {
 if(!input.trim())return null;
 const normalized=latinDigits(input.trim());
 if(!/^\d+(?:\.\d{1,2})?$/.test(normalized))return undefined;
 const [dollars,parts=""]=normalized.split(".");
 const cents=Number(dollars)*100+Number(parts.padEnd(2,"0"));
 return Number.isSafeInteger(cents)&&cents>0?cents:undefined;
}
export function parseWeeklyHours(input:string):number|null|undefined {
 if(!input.trim())return null;
 const hours=decimalInput(input);
 if(hours===undefined)return undefined;
 const minutes=hours*60;
 const nearest=Math.round(minutes);
 return nearest<=10080&&Math.abs(minutes-nearest)<0.001?nearest:undefined;
}
export function weeklyHoursInput(minutes:number|null,locale:string):string {
 return minutes===null?"":new Intl.NumberFormat(locale,{useGrouping:false,maximumFractionDigits:6}).format(minutes/60);
}
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function isValidTeamAvailability(days:TeamAvailability[]):boolean {
 return days.every(({start,end})=>(start===null&&end===null)||
  (start!==null&&end!==null&&timePattern.test(start)&&timePattern.test(end)&&start!==end));
}

export type AvailabilityWords={anyTime:string;off:string;none:string;everyDay:string};
const weekdays:number[]=[1,2,3,4,5,6,0];
const dayDate=(day:number)=>new Date(Date.UTC(2026,9,25+day));
const dayName=(day:number,locale:string)=>new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(dayDate(day));
export function formatTeamClock(value:string,locale:string):string {
 const [hour,minute]=value.split(":").map(Number);
 const n=(value:number,min=1)=>new Intl.NumberFormat(locale,{useGrouping:false,minimumIntegerDigits:min}).format(value);
 return n(hour)+(minute?":"+n(minute,2):"");
}
function dayGroups(days:number[],locale:string):string {
 const included=new Set(days);
 const groups:number[][]=[];
 for(const day of weekdays) {
  if(!included.has(day))continue;
  const last=groups[groups.length-1];
  if(last&&weekdays.indexOf(day)===weekdays.indexOf(last[last.length-1])+1)last.push(day);
  else groups.push([day]);
 }
 return groups.map(group=>group.length>=3?
  dayName(group[0],locale)+"–"+dayName(group[group.length-1],locale):
  group.map(day=>dayName(day,locale)).join(", ")).join(", ");
}
/** Describes stored owner availability, never infers it from scheduled shifts. */
export function teamAvailabilitySummary(days:TeamAvailability[],locale:string,words:AvailabilityWords):string {
 const rows=new Map(days.filter(d=>Number.isInteger(d.day)&&d.day>=0&&d.day<=6).map(d=>[d.day,d]));
 const active=weekdays.filter(day=>rows.has(day));
 if(!active.length)return words.none;
 const entries=active.map(day=>rows.get(day)!);
 const allDay=entries.every(row=>row.start===null&&row.end===null);
 if(active.length===7&&allDay)return words.anyTime;
 const sameWindow=entries.every(row=>row.start===entries[0].start&&row.end===entries[0].end);
 const description=active.length===7?words.everyDay:dayGroups(active,locale);
 if(sameWindow&&entries[0].start&&entries[0].end) {
  return description+" "+formatTeamClock(entries[0].start,locale)+"–"+formatTeamClock(entries[0].end,locale);
 }
 if(allDay){
  const off=weekdays.filter(day=>!rows.has(day));
  return description+(off.length?" · "+words.off+" "+off.map(day=>dayName(day,locale)).join(", "):"");
 }
 return entries.map(row=>dayName(row.day,locale)+(row.start&&row.end?
  " "+formatTeamClock(row.start,locale)+"–"+formatTeamClock(row.end,locale):" · "+words.anyTime)).join(" · ");
}
