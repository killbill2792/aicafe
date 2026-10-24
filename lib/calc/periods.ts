/** Pure calendar resolution; all dates are business-local YYYY-MM-DD, never UTC-now. */
export type PeriodValue = {from:string;to:string;label:string};
export type PeriodInput = {preset:"today"|"week"|"month"|"last_week"|"last_month"|"ytd"}
  | {from:string;to:string} | "today"|"week"|"month"|"last_week"|"last_month"|"ytd"|string;
export type PeriodResolution =
  | {status:"resolved"; value:PeriodValue}
  | {status:"ambiguous";candidates:PeriodValue[]}
  | {status:"none";suggestions:PeriodValue[];missing:string[]};
const ymd=/^\d{4}-\d{2}-\d{2}$/u;
const parseDate=(date:string):Date|null=>{
  if(!ymd.test(date))return null;
  const d=new Date(date+"T12:00:00Z");
  return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===date?d:null;
};
const day=(date:Date)=>date.toISOString().slice(0,10);
const offset=(date:string,n:number)=>day(new Date(Date.parse(date+"T12:00:00Z")+n*86400000));
const names=["january","february","march","april","may","june","july","august","september","october","november","december"];
export function resolvePeriod(input:PeriodInput, options:{
  asOf:string;timezone:string;coverage?:{from:string;to:string}|null
}):PeriodResolution {
  const asOf=ymd.test(options.asOf)?options.asOf:(()=>{
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:options.timezone,
      year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(options.asOf));
    const field=(kind:string)=>parts.find(p=>p.type===kind)?.value??"";
    return field("year")+"-"+field("month")+"-"+field("day");
  })();
  if(!parseDate(asOf))return {status:"none",suggestions:[],missing:["invalidAsOf"]};
  if(input&&typeof input==="object"&&"from" in input&&"to" in input){
    if(!parseDate(input.from)||!parseDate(input.to)||input.from>input.to)return {status:"none",suggestions:[],missing:["invalidPeriod"]};
    if(input.to>asOf)return {status:"none",suggestions:[],missing:["futurePeriod"]};
    return {status:"resolved",value:{from:input.from,to:input.to,label:input.from+" – "+input.to}};
  }
  const preset=typeof input==="string"?input:input.preset;
  const month=asOf.slice(0,7)+"-01";
  const previousMonth=offset(month,-1);
  const prevStart=previousMonth.slice(0,7)+"-01";
  const monday=offset(asOf,-((new Date(asOf+"T12:00:00Z").getUTCDay()+6)%7));
  const periods:Record<string,PeriodValue>={
    today:{from:asOf,to:asOf,label:"Today"},
    week:{from:offset(asOf,-6),to:asOf,label:"Last 7 days"},
    month:{from:month,to:asOf,label:"This month"},
    last_week:{from:offset(monday,-7),to:offset(monday,-1),label:"Last week"},
    last_month:{from:prevStart,to:offset(month,-1),label:"Last month"},
    ytd:{from:asOf.slice(0,4)+"-01-01",to:asOf,label:"Year to date"},
  };
  if(periods[preset])return {status:"resolved",value:periods[preset]};
  const normalized=preset.trim().toLowerCase();
  const named=normalized.match(/^([a-z]+)(?:\s+(\d{4}))?$/u);
  const index=named?names.indexOf(named[1]):-1;
  if(index<0)return {status:"none",suggestions:[],missing:["unknownPeriod"]};
  const coverage=options.coverage;
  const years=named?.[2]?[Number(named[2])]:
    coverage?Array.from({length:Math.min(10,Number(coverage.to.slice(0,4))-Number(coverage.from.slice(0,4))+1)},
      (_,i)=>Number(coverage.from.slice(0,4))+i):
      [Number(asOf.slice(0,4)),Number(asOf.slice(0,4))-1];
  const candidates=years.map(year=>{
    const from=year+"-"+String(index+1).padStart(2,"0")+"-01";
    const to=offset(year+"-"+String(index+1).padStart(2,"0")+"-01",0);
    const last=day(new Date(Date.UTC(year,index+1,0,12)));
    return {from,to:last>asOf?asOf:last,label:names[index][0].toUpperCase()+names[index].slice(1)+" "+year};
  }).filter(x=>x.from<=x.to&&x.from<=asOf&&(!coverage||x.to>=coverage.from&&x.from<=coverage.to));
  if(candidates.length>1)return {status:"ambiguous",candidates:candidates.slice(0,4)};
  if(candidates.length===1)return {status:"resolved",value:candidates[0]};
  return {status:"none",suggestions:[],missing:["periodNotCovered"]};
}
