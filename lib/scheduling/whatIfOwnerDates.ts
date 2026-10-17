import { parseOwnerDateWindows } from "@/lib/ai/conversations/ownerDateIntent";

const weekdays:Record<string,number>={
  sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
  domingo:0,lunes:1,martes:2,miércoles:3,miercoles:3,jueves:4,viernes:5,sábado:6,sabado:6,
  الأحد:0,الاثنين:1,الإثنين:1,الثلاثاء:2,الأربعاء:3,الخميس:4,الجمعة:5,السبت:6,
};
const add=(day:string,n:number)=>new Date(Date.parse(day+"T12:00:00Z")+n*86400000)
  .toISOString().slice(0,10);
const monday=(day:string)=>add(day,-((new Date(day+"T12:00:00Z").getUTCDay()+6)%7));
/** Calendar grammar only, not question/intent routing. An explicit date binds the
 * simulated horizon; a bare weekday means its next occurrence, including today.
 * This/next week qualify that weekday relative to the trusted café-local clock. */
export function matchesOwnerScheduleDates(input:{week:string;overrides:readonly object[]},
  clause:string,asOf:string):boolean{
  const dates=input.overrides.flatMap(o=>"localDate" in o && typeof o.localDate==="string"?[o.localDate]:[]);
  if(dates.some(d=>d<input.week||d>add(input.week,6)))return false;
  // Scheduling is forward-looking: a yearless named date can be later in
  // the current year. Historical finance parsing deliberately disallows it.
  const direct=parseOwnerDateWindows(clause,asOf);
  const explicit=direct.length?direct:parseOwnerDateWindows(clause,asOf.slice(0,4)+"-12-31");
  if(!explicit.length && /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/u.test(clause))return false;
  if(explicit.length){
    return dates.length
      ? dates.every(d=>explicit.some(w=>d>=w.from&&d<=w.to))
      : explicit.every(w=>w.from>=input.week&&w.to<=add(input.week,6));
  }
  const words=clause.toLocaleLowerCase().match(/[\p{L}]+/gu)??[];
  const days=[...new Set(words.filter(w=>Object.hasOwn(weekdays,w)).map(w=>weekdays[w]))];
  const nextWeek=/\bnext\s+week\b|\b(?:próxima|proxima|siguiente)\s+semana\b|الأسبوع\s+القادم/iu.test(clause);
  const thisWeek=/\bthis\s+week\b|\besta\s+semana\b|هذا\s+الأسبوع/iu.test(clause);
  const anchor=monday(asOf);
  if(nextWeek||thisWeek){
    const week=nextWeek?add(anchor,7):anchor;
    if(input.week!==week)return false;
    return !days.length || dates.every(d=>days.includes(new Date(d+"T12:00:00Z").getUTCDay()));
  }
  if(!days.length)return true; // Unspecified calendar constraints remain visible in the result.
  const today=new Date(asOf+"T12:00:00Z").getUTCDay();
  const expected=days.map(day=>add(asOf,(day-today+7)%7));
  return dates.length?dates.every(d=>expected.includes(d)):
    expected.every(d=>d>=input.week&&d<=add(input.week,6));
}
