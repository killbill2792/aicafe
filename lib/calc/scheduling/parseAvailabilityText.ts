export type ProposedDay={day:number;start:string|null;end:string|null};
export type AvailabilityTextProposal={
 personName:string;availability:ProposedDay[];offDays:number[];
 needsOwnerApproval:true;assumptions:string[];offDates?:string[];
};
/** Narrow, review-only parser. Unrecognized instructions fail closed, never write.
 * Day indices use JS Sunday=0...Saturday=6. */
const days:Record<string,number>={
 sun:0,sunday:0,dom:0,domingo:0,الأحد:0,
 mon:1,monday:1,lun:1,lunes:1,الاثنين:1,
 tue:2,tues:2,tuesday:2,mar:2,martes:2,الثلاثاء:2,
 wed:3,wednesday:3,mie:3,mié:3,miercoles:3,miércoles:3,الأربعاء:3,
 thu:4,thur:4,thurs:4,thursday:4,jue:4,jueves:4,الخميس:4,
 fri:5,friday:5,vie:5,viernes:5,الجمعة:5,
 sat:6,saturday:6,sab:6,sáb:6,sábado:6,السبت:6
};
function hour(hourText:string,part:string|undefined):number|null {
 const n=Number(hourText);if(!Number.isInteger(n)||n<0||n>23)return null;
 if(!part)return n;
 if(n<1||n>12)return null;
 return part.toLowerCase().startsWith("p")?n%12+12:n%12;
}
const hh=(n:number)=>String(n).padStart(2,"0")+":00";
export function parseAvailabilityText(text:string,asOf?:string):AvailabilityTextProposal|null {
 // Common owner instructions are parsed deterministically, without making a write.
 const only=text.trim().match(/^(.+?)\s+can\s+only\s+work\s+(.+?)\s+(mornings|afternoons|evenings)\.?$/iu);
 if(only){
  const personName=only[1].trim();
  const tokens=only[2].replace(/\s+and\s+/giu,",").split(/\s*,\s*/u).map(s=>s.trim().toLowerCase());
  const weekdays=tokens.map(t=>days[t]);
  if(!personName||personName.length>80||!weekdays.length||weekdays.some(d=>d===undefined)||new Set(weekdays).size!==weekdays.length)return null;
  const window=only[3].toLowerCase()==="mornings"?["06:00","12:00"]:
    only[3].toLowerCase()==="afternoons"?["12:00","17:00"]:["17:00","22:00"];
  const offDays=Array.from({length:7},(_,d)=>d).filter(d=>!weekdays.includes(d));
  return {personName,offDays,availability:weekdays.sort((a,b)=>a-b)
    .map(day=>({day,start:window[0],end:window[1]})),needsOwnerApproval:true,
    assumptions:["Review the exact "+only[3]+" time window before approving"]};
 }
 const absence=text.trim().match(/^(.+?)\s+(?:is\s+off|cannot\s+work|can't\s+work)\s+next\s+([a-z]+)\.?$/iu);
 if(absence&&asOf&&/^\d{4}-\d{2}-\d{2}$/u.test(asOf)){
  const day=days[absence[2].toLowerCase()],name=absence[1].trim();
  if(day===undefined||!name||name.length>80)return null;
  const now=new Date(asOf+"T12:00:00Z");
  if(Number.isNaN(now.valueOf()))return null;
  const offset=((day-now.getUTCDay()+7)%7)||7;
  now.setUTCDate(now.getUTCDate()+offset);
  return {personName:name,offDays:[],offDates:[now.toISOString().slice(0,10)],
    availability:[],needsOwnerApproval:true,assumptions:[]};
 }
 const chunks=text.trim().split(/\s*;\s*/);
 if(chunks.length!==2)return null;
 const first=chunks[0].match(/^(.+?)\s+(?:can't work|cannot work|is not available|no puede trabajar|لا يمكنه العمل)\s+(.+)$/iu);
 if(!first)return null;
 const personName=first[1].trim();
 if(!personName||personName.length>80)return null;
 const parts=first[2].toLowerCase().split(/[،,\s]+/u).filter(Boolean);
 const off=[...new Set(parts.map(part=>days[part]))];
 if(!parts.length||off.some(d=>d===undefined))return null;
 const second=chunks[1].match(/^(?:free|available|libre|disponible|متاح)\s+(\d{1,2})\s*(am|pm)?\s*(?:[-–—]|to|a|إلى)\s*(\d{1,2})\s*(am|pm)?\s+(?:other days|the other days|otros días|los otros días|بقية الأيام)\.?$/iu);
 if(!second)return null;
 const start=hour(second[1],second[2]),end=hour(second[3],second[4]);
 if(start===null||end===null||start===end)return null;
 const assumptions:string[]=[];
 if(!second[2]&&!second[4]){
  if(start>=end)return null;
  assumptions.push("Hours without AM/PM interpreted as morning/daytime");
 }
 if(start>end)assumptions.push("Overnight availability window");
 return {personName,offDays:off.sort((a,b)=>a-b),
  availability:Array.from({length:7},(_,day)=>day).filter(day=>!off.includes(day))
   .map(day=>({day,start:hh(start),end:hh(end)})),
  needsOwnerApproval:true,assumptions};
}
