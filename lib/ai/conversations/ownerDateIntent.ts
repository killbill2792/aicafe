import type { RequestedGoal } from "./requestScope";
import { normalizeRequestedGoals, SNAPSHOT_GOAL_DOMAINS } from "./requestScope";

/** Temporal constraints are parsed from the OWNER'S words, never from a model-supplied
 * calendar range. This is date grammar, not a question-to-capability router. */
export type OwnerDateWindow={from:string;to:string};
const monthNames:Record<string,number>={
  january:1,jan:1,enero:1,يناير:1,
  february:2,feb:2,febrero:2,فبراير:2,
  march:3,mar:3,marzo:3,مارس:3,
  april:4,apr:4,abril:4,أبريل:4,
  may:5,mayo:5,مايو:5,
  june:6,jun:6,junio:6,يونيو:6,
  july:7,jul:7,julio:7,يوليو:7,
  august:8,aug:8,agosto:8,أغسطس:8,
  september:9,sept:9,sep:9,septiembre:9,setiembre:9,سبتمبر:9,
  october:10,oct:10,octubre:10,أكتوبر:10,
  november:11,nov:11,noviembre:11,نوفمبر:11,
  december:12,dec:12,diciembre:12,ديسمبر:12,
};
const monthWord=Object.keys(monthNames).sort((a,b)=>b.length-a.length).join("|");
const monthFirst=new RegExp("(?<![\\p{L}])("+monthWord+")[\\s,]+(\\d{1,2})(?:st|nd|rd|th)?(?:[\\s,]+(\\d{4}))?","giu");
const dayFirst=new RegExp("(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|de\\s+)?("+monthWord+")(?:[\\s,]+(\\d{4}))?","giu");
const weekDays:Record<string,number>={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
  domingo:0,lunes:1,martes:2,miércoles:3,miercoles:3,jueves:4,viernes:5,sábado:6,sabado:6};
const iso=(d:Date)=>d.toISOString().slice(0,10);
function date(year:number,month:number,day:number):string|null{
  const d=new Date(Date.UTC(year,month-1,day,12));
  return d.getUTCFullYear()===year && d.getUTCMonth()===month-1 && d.getUTCDate()===day?iso(d):null;
}
function anchoredDate(month:number,day:number,year:string|undefined,asOf:string):string|null{
  const anchor=Number(asOf.slice(0,4)),y=year?Number(year):anchor;
  const result=date(y,month,day);
  // An unspecified year on a future calendar date is genuinely ambiguous.
  if(!year && result && result>asOf)return null;
  return result;
}
type Hit={day:string;start:number;end:number};
function hitsForNamedDates(text:string,asOf:string):Hit[]{
  const hits:Hit[]=[];
  for(const match of text.matchAll(monthFirst)){
    const day=anchoredDate(monthNames[match[1].toLocaleLowerCase()],Number(match[2]),match[3],asOf);
    if(day)hits.push({day,start:match.index,end:match.index+match[0].length});
  }
  for(const match of text.matchAll(dayFirst)){
    const day=anchoredDate(monthNames[match[2].toLocaleLowerCase()],Number(match[1]),match[3],asOf);
    if(day && !hits.some(h=>match.index<h.end&&match.index+match[0].length>h.start))
      hits.push({day,start:match.index,end:match.index+match[0].length});
  }
  for(const match of text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu)){
    const day=match[0];
    if(date(Number(day.slice(0,4)),Number(day.slice(5,7)),Number(day.slice(8)))===day)
      hits.push({day,start:match.index,end:match.index+day.length});
  }
  return hits.sort((a,b)=>a.start-b.start);
}
/** Empty means no safely resolvable explicit date constraint, NOT license to guess. */
export function parseOwnerDateWindows(text:string,asOf:string):OwnerDateWindow[]{
  const named=hitsForNamedDates(text,asOf);
  if(named.length===2){
    const before=text.slice(0,named[0].start).toLocaleLowerCase();
    const between=text.slice(named[0].end,named[1].start).toLocaleLowerCase();
    const continuous=/\b(?:between|from|desde|entre)\b/u.test(before)||
      /\b(?:to|through|until|thru|hasta|al)\b/u.test(between);
    if(continuous)return named[0].day<=named[1].day?
      [{from:named[0].day,to:named[1].day}]:[];
    // Two dates connected as alternatives, distinct days, or compared days.
    return named.map(h=>({from:h.day,to:h.day}));
  }
  if(named.length===1)return [{from:named[0].day,to:named[0].day}];
  if(named.length>2)return [];
  const firstWeek=text.match(new RegExp("(?:first|primera)\\s+(?:week|semana)\\s+(?:of|de)\\s+("+monthWord+")(?:\\s+(\\d{4}))?","iu"));
  if(firstWeek){
    const m=monthNames[firstWeek[1].toLocaleLowerCase()],first=anchoredDate(m,1,firstWeek[2],asOf);
    const last=anchoredDate(m,7,firstWeek[2],asOf);
    if(first && last)return [{from:first,to:last}];
  }
  const weekday=text.match(/\b(?:last|pasado|pasada)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/iu);
  if(weekday){
    const anchor=new Date(asOf+"T12:00:00Z"),target=weekDays[weekday[1].toLocaleLowerCase()];
    if(!Number.isNaN(anchor.getTime())){
      const elapsed=(anchor.getUTCDay()-target+7)%7||7;
      anchor.setUTCDate(anchor.getUTCDate()-elapsed);
      const day=iso(anchor);
      return [{from:day,to:day}];
    }
  }
  return [];
}
/** Referents are resolved only to explicitly dated OWNER turns, not a model's
 * memory or generated financial figures. An unrelated follow-up is untouched. */
export function ownerDateWindowsFromContext(text:string,asOf:string,
  history:readonly {role:string;text:string}[]=[]):OwnerDateWindow[]{
  const direct=parseOwnerDateWindows(text,asOf);
  if(direct.length)return direct;
  if(!/\b(?:those|these|both)\s+(?:two\s+)?(?:days|dates)\b|\bthat\s+(?:day|date)\b|\b(?:esos|esas|ambas)\s+(?:días|dias|fechas)\b|تلك\s+الأيام|هذين\s+اليومين/iu.test(text))
    return [];
  for(const turn of [...history].reverse()){
    if(turn.role!=="owner")continue;
    const previous=parseOwnerDateWindows(turn.text,asOf);
    if(previous.length)return previous;
  }
  return [];
}
const periodDomains=new Set<RequestedGoal["domain"]>([
  "profit_margin","owner_profit","total_business_costs","sales","distinct_products",
  "recorded_spending","staff_cost","staff_attendance","staffing",
]);
/** Reconcile the two independent semantic readings against *the same* explicit
 * owner calendar constraints. Source selectors never accept model-chosen dates alone. */
export function alignGoalsToOwnerDates(goals:RequestedGoal[],text:string,asOf:string,
  history:readonly {role:string;text:string}[]=[]):RequestedGoal[]{
  const windows=ownerDateWindowsFromContext(text,asOf,history);
  if(!windows.length)return normalizeRequestedGoals(goals);
  const out:RequestedGoal[]=[];
  for(const g of goals){
    if(g.domain==="comparison" && windows.length===2){
      // Comparison metric remains model-chosen and must match the read call.
      // Only the two calendar selectors are verified from owner context.
      out.push({...g,period:"custom",from:windows[1].from,to:windows[1].to,
        comparison_period:"custom",comparison_from:windows[0].from,
        comparison_to:windows[0].to});
      continue;
    }
    if(!periodDomains.has(g.domain) ||
       (SNAPSHOT_GOAL_DOMAINS as readonly string[]).includes(g.domain)){
      out.push(g);continue;
    }
    for(const w of windows)out.push({...g,period:"custom",from:w.from,to:w.to,
      comparison_period:null,comparison_from:null,comparison_to:null});
  }
  return normalizeRequestedGoals(out);
}
