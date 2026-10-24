/** Validate typed shift inputs without coercion before any schedule math or write. */
export const validShiftClock=(clock:string)=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock);
export function scheduledShiftMinutes(start:string,end:string):number|null {
 if(!validShiftClock(start)||!validShiftClock(end)||start===end)return null;
 const minutes=(clock:string)=>Number(clock.slice(0,2))*60+Number(clock.slice(3));
 return (minutes(end)-minutes(start)+1440)%1440;
}
export function parseUnpaidBreakMinutes(text:string,shiftMinutes:number|null):number|null {
 const normalized=text.trim().replace(/[\u0660-\u0669\u06f0-\u06f9]/g,character=>{
  const code=character.charCodeAt(0);return String(code>=0x6f0?code-0x6f0:code-0x660);
 });
 if(shiftMinutes===null||!/^\d{1,3}$/.test(normalized))return null;
 const minutes=Number(normalized);
 return minutes<=240&&minutes<shiftMinutes?minutes:null;
}
