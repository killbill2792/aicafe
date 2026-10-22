import type { AgentLocale, AgentToolResult } from "./tools";
import { menuPriceDifferenceCents } from "@/lib/calc/agentPriceDifferences";

export type MenuPrice = {id:string;name:string;priceCents:number};
export type TimeScope = {kind:"hours";days:string[]} | {kind:"schedule";from:string;to:string};
export type NumericEvidence = {tool:string;values:Array<{key:string;value:number;unit:"cents"|"bps"|"ratio"|"count"}>;
  times?:VerifiedTime[];timeScope?:TimeScope;prices?:MenuPrice[]};
// Only business collections, not diagnostics or metadata, establish counts.
// This same contract applies to current-turn and persisted numeric evidence.
const COUNTABLE_COLLECTIONS = new Set(["items","people","shifts","laborDays","days","categories","attendanceRecords"]);
const NON_EVIDENCE_FIELDS = new Set(["source","agentId","labels","period","date",
  "missing","estimated","warnings","stale","quality","missingInputs","estimatedInputs","staleInputs",
  "dayOfWeek","weekday","dayIndex","weekDay","dayNumber","sortOrder","priority","index"]);
// Quantities must have documented business meaning; a numeric enum or arbitrary
// internal field does not become evidence of how many drinks were sold.
const COUNTABLE_FIELDS = new Set(["count","itemCount","quantity","units","totalUnits","totalCount",
  "coveredSalesDays","expectedSalesDays","salesDays","laborDays","expectedDays",
  "missingProductCostCount","drinksNeededPerDay","drinksPerHour","todayDrinks",
  "ordersCount","staffCount","shiftCount","employeesCount","attendanceCount",
  "timecardCount","onClockCount"]);
const trustedCountKey=(key:string)=>COUNTABLE_FIELDS.has(key.split("/").at(-1)??"")||
  COUNTABLE_COLLECTIONS.has((key.split("/").at(-1)??"").replace(/Length$/u,""));

/** Collect the complete current observations first. Apply the persistence cap
 * only after collection, prioritizing recent reads and high-value prices. */
export function compactEvidence(results:readonly AgentToolResult[],limit=100):NumericEvidence[]{
  const gathered=results.map(r=>{
    const values:NumericEvidence["values"]=[];
    const periodKey=r.period?r.period.from+"/"+r.period.to+"/":"";
    const rootId=typeof r.itemId==="string"?r.itemId:null;
    const rootScope=rootId?"item:"+rootId+"/":"";
    const walk=(v:unknown,key:string,depth:number,scope="")=>{
      if(depth>6||NON_EVIDENCE_FIELDS.has(key))return;
      if(Array.isArray(v)){
        if(COUNTABLE_COLLECTIONS.has(key))
          values.push({key:periodKey+scope+key+"Length",value:v.length,unit:"count"});
        for(const item of v){
          const scoped=item&&typeof item==="object"&&!Array.isArray(item)&&"id" in item&&
            typeof item.id==="string"?scope+key+":"+item.id+"/":scope;
          walk(item,key,depth+1,scoped);
        }
        return;
      }
      if(v&&typeof v==="object"){
        for(const [k,item] of Object.entries(v)){
          const scoped=k==="item"&&item&&typeof item==="object"&&!Array.isArray(item)&&
            "id" in item&&typeof item.id==="string"?scope+"item:"+item.id+"/":scope;
          walk(item,k,depth+1,scoped);
        }
        return;
      }
      if(typeof v!=="number"||!Number.isFinite(v))return;
      const unit=/Cents$|Micros$/.test(key)?"cents":/Bps$|Percent$/.test(key)?"bps":
        /Margin$|Ratio$/.test(key)?"ratio":COUNTABLE_FIELDS.has(key)?"count":null;
      if(!unit)return;
      values.push({key:periodKey+scope+key,value:/Micros$/.test(key)?v/1000000:/Percent$/.test(key)?v*100:v,unit});
    };
    walk(r,"",0,rootScope);
    const times=[...observedHours([r]),...observedShifts([r])].slice(0,60);
    let timeScope:TimeScope|undefined;
    if(r.source==="locations.open_hours"&&r.hours&&typeof r.hours==="object"&&!Array.isArray(r.hours))
      timeScope={kind:"hours",days:DAY_MENTIONS.map(d=>d.key).filter(d=>Object.hasOwn(r.hours as object,d))};
    if(r.source==="recurring_schedule"&&r.period?.from&&r.period?.to)
      timeScope={kind:"schedule",from:r.period.from,to:r.period.to};
    const prices:MenuPrice[]=[];
    const record=(item:unknown)=>{
      if(!item||typeof item!=="object"||Array.isArray(item))return;
      const row=item as Record<string,unknown>;
      if(typeof row.id==="string"&&typeof row.name==="string"&&
        typeof row.priceCents==="number"&&Number.isSafeInteger(row.priceCents))
        prices.push({id:row.id,name:row.name,priceCents:row.priceCents});
    };
    if(r.source==="menu_items"&&Array.isArray(r.items))r.items.forEach(record);
    if(r.source==="product_costs")record(r.item);
    // Pricing recommendations can report a singleton itemId, but its
    // display name is not available: retain scoped cents, not invented names.
    return {tool:r.source,values,times,timeScope,prices:prices.slice(0,25)};
  });
  if(Number.isFinite(limit)){
    // Latest reads and item prices are the most valuable persisted evidence.
    let remaining=Math.max(0,Math.floor(limit));
    for(const entry of [...gathered].reverse()){
      const prioritized=[...entry.values].sort((a,b)=>
        Number(b.key.endsWith("priceCents"))-Number(a.key.endsWith("priceCents")));
      const keep=prioritized.slice(0,remaining);
      remaining-=keep.length;
      entry.values=keep;
    }
  }
  return gathered.filter(e=>e.values.length>0||e.times.length>0||
    (e.timeScope?.kind==="hours"&&e.timeScope.days.length>0)||
    e.timeScope?.kind==="schedule"||e.prices.length>0);
}
/** Saved turns arrive oldest first. An updated value for the same
 * source/item/period key replaces its predecessor, never unions with it.
 * Legacy unscoped keys cannot overrule newer scoped values. */
function offsetDate(date:string,days:number):string {
  return new Date(Date.parse(date+"T12:00:00Z")+days*86400000).toISOString().slice(0,10);
}
function reconcileSavedEvidence(entries:readonly NumericEvidence[]):NumericEvidence[]{
  type Value=NumericEvidence["values"][number];
  const bySource=new Map<string,{values:Map<string,Value[]>;times:VerifiedTime[];
    prices:Map<string,MenuPrice>}>();
  for(const entry of entries){
    let slot=bySource.get(entry.tool);
    if(!slot){slot={values:new Map(),times:[],prices:new Map()};bySource.set(entry.tool,slot);}
    const grouped=new Map<string,Value[]>();
    for(const v of entry.values){
      if(typeof v.key!=="string"||!Number.isFinite(v.value))continue;
      const group=grouped.get(v.key)??[];
      group.push(v);grouped.set(v.key,group);
    }
    for(const [key,group] of grouped){
      if(key.includes("/"))
        slot.values.delete(key.split("/").at(-1)??"");
      slot.values.set(key,group);
    }
    for(const price of entry.prices??[]){
      if(typeof price.id==="string"&&typeof price.name==="string"&&
        Number.isSafeInteger(price.priceCents))slot.prices.set(price.id,price);
    }
    const times=(entry.times??[]).slice(0,60).filter(t=>
      t&&typeof t.time==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(t.time)&&
      typeof t.day==="string"&&typeof t.role==="string"&&typeof t.complete==="boolean");
    if(entry.timeScope?.kind==="hours"){
      const updated=new Set(entry.timeScope.days);
      slot.times=slot.times.filter(t=>!(["open","close"].includes(t.role)&&updated.has(t.day)));
      slot.times.push(...times);
    }else if(entry.timeScope?.kind==="schedule"){
      const {from,to}=entry.timeScope;
      if(from<=to){
        const retained:VerifiedTime[]=[];
        for(const t of slot.times){
          if(!["shiftStart","shiftEnd"].includes(t.role)||
            (t.validTo??"9999-12-31")<from||(t.validFrom??"0000-01-01")>to){
            retained.push(t);continue;
          }
          // Read windows may overlap partially. Subtract only the observed
          // window, leaving accurately sourced adjacent periods intact.
          if(t.validFrom&&t.validFrom<from)
            retained.push({...t,validTo:offsetDate(from,-1)});
          if(t.validTo&&t.validTo>to)
            retained.push({...t,validFrom:offsetDate(to,1)});
        }
        slot.times=[...retained,...times];
      }
    }else if(times.length){
      // Older saved payloads without scope can still provide typed clocks.
      const oldKeys=new Set(times.map(t=>[t.day,t.role,t.person,t.validFrom,t.validTo].join("/")));
      slot.times=slot.times.filter(t=>
        !oldKeys.has([t.day,t.role,t.person,t.validFrom,t.validTo].join("/")));
      slot.times.push(...times);
    }
  }
  return [...bySource].map(([tool,slot])=>({
    tool,values:[...slot.values.values()].flat(),times:slot.times,
    prices:[...slot.prices.values()]
  })).filter(e=>e.values.length>0||e.times.length>0||e.prices.length>0);
}

export type UnverifiedNumber = { text: string; start: number; end: number; kind: "money" | "percent" | "number" };
type Kind = UnverifiedNumber["kind"];
const ascii = (s: string) => s.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0))
  .replace(/٬/g, "").replace(/٫/g, ".").replace(/٪/g, "%");
function decimal(raw: string, locale: AgentLocale): number {
  let s = ascii(raw).replace(/[\s\u00a0\u202f]/g, "");
  const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    s = dot > comma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (comma >= 0) {
    const frac = s.length - comma - 1;
    s = (frac === 3 && locale === "en") ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (dot >= 0) {
    const frac = s.length - dot - 1;
    if (frac === 3 && locale !== "en") s = s.replace(".", "");
  }
  return Number(s);
}
const currency = "(?:[$€£]|USD|EUR|GBP|ر\\.س|د\\.إ|دولار|دولارات|ريال|درهم|dollars?|euros?|pesos?|dólares?)";
const digits = "[-+−]?[٠-٩۰-۹\\d]+";
function numberPattern(locale: AgentLocale): RegExp {
  // Ordinary spaces separate words (and numbers); localized nonbreaking
  // grouping spaces are allowed between digits only in ES/AR.
  const separators = locale === "en" ? "[.,٬٫]" : "[.,٬٫\\u00a0\\u202f]";
  const number = digits + "(?:" + separators + "[٠-٩۰-۹\\d]+)*";
  return new RegExp("(?<![\\p{L}\\p{N}_])(?:[-+−]\\s*" + currency + "\\s*|" + currency + "\\s*)?" + number +
    "(?:\\s*(?:[%٪]|" + currency + "))?(?![\\p{L}\\p{N}_])", "gu");
}
const months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)";
const monthBefore = new RegExp(months + "[\\s,]*$", "iu");
const monthDayBefore = new RegExp(months + "[\\s]+[٠-٩۰-۹\\d]{1,2}[,\\s]*$", "iu");
const monthAfter = new RegExp("^\\s*(?:de\\s+)?" + months + "(?!\\p{L})", "iu");
const yearBefore = /(?:^|[\s(])(?:in|en|del|año|year|fy|q[1-4]|عام|سنة)\s*$/iu;
const isoDate = /[٠-٩۰-۹\d]{4}[-/][٠-٩۰-۹\d]{1,2}[-/][٠-٩۰-۹\d]{1,2}/gu;
function isCalendarNumber(text: string, start: number, end: number, value: number, kind: Kind): boolean {
  if (kind !== "number" || !Number.isInteger(value)) return false;
  // An ISO/slash date contains several numeric tokens; exempt all of them.
  if ([...text.matchAll(isoDate)].some(match =>
    start < match.index + match[0].length && end > match.index)) return true;
  const before = text.slice(Math.max(0, start - 28), start);
  const after = text.slice(end, end + 28);
  if (value >= 2000 && value <= 2100) {
    return monthBefore.test(before) || monthDayBefore.test(before) ||
      monthAfter.test(after) || yearBefore.test(before);
  }
  if (value >= 1 && value <= 31)
    return monthBefore.test(before) || monthAfter.test(after);
  return false;
}
function candidates(text: string, locale: AgentLocale): Array<UnverifiedNumber & { value: number; wholePercent: boolean }> {
  const found: Array<UnverifiedNumber & { value: number; wholePercent: boolean }> = [];
  for (const m of text.matchAll(numberPattern(locale))) {
    const token = m[0].trim(), money = new RegExp(currency, "iu").test(token);
    const percent = /[%٪]$/.test(token);
    const raw = token.replace(new RegExp(currency, "giu"), "").replace(/[%٪]/g, "").trim().replace("−", "-");
    const value = decimal(raw, locale);
    if (!Number.isFinite(value)) continue;
    const kind: Kind = money ? "money" : percent ? "percent" : "number";
    if (isCalendarNumber(text, m.index, m.index + m[0].length, value, kind)) continue;
    found.push({ text: token, start: m.index, end: m.index + m[0].length, kind,
      wholePercent: percent && !/[.,٫٬]/.test(raw),
      value: kind === "money" || kind === "percent" ? Math.round(value * 100) : value });
  }
  return found;
}
/** Only actual list positions are exempt, not sentence-ending business counts. */
function isListMarker(text: string, start: number, end: number, value: number): boolean {
  if (!Number.isInteger(value) || value < 1 || value > 30 ||
    !/^[.)][ \t]+\S/u.test(text.slice(end))) return false;
  const before = text.slice(0, start);
  const breakAt = before.lastIndexOf("\n");
  const line = before.slice(breakAt + 1);
  // Lists begin at 1; subsequent lines must continue a previous list.
  // A standalone "9. Sales are missing" is not safely a list marker.
  if (/^[ \t]*$/u.test(line)) {
    if (value === 1) return true;
    const priorLine = before.slice(0, breakAt).split("\n").reverse()
      .find(candidate => candidate.trim().length > 0) ?? "";
    const priorMarker = priorLine.match(/^[ \t]*([1-9]\d?)[.)][ \t]+\S/u);
    return priorMarker !== null && Number(priorMarker[1]) + 1 === value;
  }
  // Compact numbered lists such as "1. Latte 2. Mocha" continue sequentially.
  if (!/^[ \t]*1[.)][ \t]+\S/u.test(line)) return false;
  const markers = [...line.matchAll(/(?:^|[ \t])([1-9]\d?)[.)][ \t]+\S/gu)];
  return markers.length > 0 && Number(markers[markers.length - 1][1]) + 1 === value;
}

/** Plain monetary wording can use dollar values without a currency symbol;
 * cents must not be promoted to evidence for arbitrary item or staff counts. */
function isCurrencylessMoneyClaim(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 100), start).split(/[.!?;,\n]/u).pop() ?? "";
  const after = (text.slice(end).split(/[.!?;,\n]/u)[0] ?? "").slice(0, 40);
  if (/^\s*(?:(?:more|fewer)\s+)?(?:drinks?|orders?|people|staff|employees?|items?|cups?|units?|hours?|days?|coffees?|customers?|shifts?|servings?|tickets?|ounces?|oz|grams?|kg|liters?|litres?|lattes?|mochas?)\b/iu.test(after) ||
    /\b(?:sold|served|ordered|count|quantity|number of|staff|employees?|customers?|shifts?)\b[^.!?;,\n]*$/iu.test(before)) return false;
  const moneyWords = /\b(?:profit|loss|revenues?|sales|prices?|costs?|charges?|rents?|bills?|fees?|salar(?:y|ies)|wages?|payroll|expenses?|income|cash|budget|amount|balance|latte|mocha|espresso|cappuccino|americano|tea|coffee|sandwich|croissant|muffin|brownie|beneficio|ganancia|ingresos|precio|costo|coste|alquiler|gastos?)\b|(?:الربح|الإيرادات|الايرادات|السعر|التكلفة|الإيجار)/iu;
  return moneyWords.test(before) || /^\s*(?:in\s+)?(?:profit|revenue|sales|costs?|expenses?|income|cash|rent|wages?|payroll|ganancia|beneficio|ingresos)\b/iu.test(after);
}

/** Known configured hours remain evidence for their own weekday even when
 * other weekdays are missing. An unknown weekday is never silently closed. */
/** A computed price difference is valid only for both named menu items and
 * the asserted direction, never for any arbitrary pair in the price list. */
function verifiedMenuDifference(text:string,start:number,end:number,cents:number,
  prices:readonly MenuPrice[]):boolean {
  if(cents<0)return false;
  const before=text.slice(0,start);
  const sentenceStart=Math.max(before.lastIndexOf("."),before.lastIndexOf("!"),
    before.lastIndexOf("?"),before.lastIndexOf("\n"))+1;
  const lhs=before.slice(sentenceStart);
  const after=text.slice(end);
  const sentenceEnd=after.search(/[.!?\n]/u);
  const rhs=after.slice(0,sentenceEnd<0?undefined:sentenceEnd);
  const comparison=rhs.match(/^\s*(more than|less than|cheaper than|pricier than)\s+(?:the\s+)?/iu);
  if(!comparison)return false;
  const matchName=(name:string,part:string,pos:number):boolean=>{
    if(part.toLocaleLowerCase().slice(pos,pos+name.length)!==name.toLocaleLowerCase())return false;
    const prev=part[pos-1]??" ",next=part[pos+name.length]??" ";
    return !/[\p{L}\p{M}\p{N}]/u.test(prev)&&!/[\p{L}\p{M}\p{N}]/u.test(next);
  };
  const named=prices.filter(p=>p.name.trim()&&Number.isSafeInteger(p.priceCents));
  const leftMatches=named.map(p=>{
    const at=lhs.toLocaleLowerCase().lastIndexOf(p.name.toLocaleLowerCase());
    return {price:p,at:at>=0&&matchName(p.name,lhs,at)?at:-1};
  }).filter(x=>x.at>=0).sort((a,b)=>b.at-a.at);
  const rightPart=rhs.slice(comparison[0].length);
  const rightMatches=named.filter(p=>matchName(p.name,rightPart,0))
    .sort((a,b)=>b.name.length-a.name.length);
  if(!leftMatches.length||!rightMatches.length)return false;
  const left=leftMatches[0].price,right=rightMatches[0];
  if(left.id===right.id||
    leftMatches.some(x=>x.at===leftMatches[0].at&&x.price.id!==left.id)||
    rightMatches.some(x=>x.name.toLocaleLowerCase()===right.name.toLocaleLowerCase()&&x.id!==right.id))
    return false;
  const direction=/^(?:more|pricier)/iu.test(comparison[1])?"more":"less";
  const delta=menuPriceDifferenceCents(left.priceCents,right.priceCents,direction);
  return delta!==null&&Math.abs(delta-cents)<=1;
}

const DAY_MENTIONS = [
  {key:"sun", pattern:/\b(?:sunday|sun|domingo)\b|الأحد/iu},
  {key:"mon", pattern:/\b(?:monday|mon|lunes)\b|(?:الإثنين|الاثنين)/iu},
  {key:"tue", pattern:/\b(?:tuesday|tue|martes)\b|الثلاثاء/iu},
  {key:"wed", pattern:/\b(?:wednesday|wed|miércoles|miercoles)\b|الأربعاء/iu},
  {key:"thu", pattern:/\b(?:thursday|thu|jueves)\b|الخميس/iu},
  {key:"fri", pattern:/\b(?:friday|fri|viernes)\b|الجمعة/iu},
  {key:"sat", pattern:/\b(?:saturday|sat|sábado|sabado)\b|السبت/iu},
];
type TimeRole = "open"|"close"|"shiftStart"|"shiftEnd";
type ClockSpan = RegExpMatchArray & {index:number};
type VerifiedTime = {day:string;time:string;role:TimeRole;complete:boolean;person:string|null;
  validFrom?:string;validTo?:string};
const clockEnd = (clock:ClockSpan) => clock.index+clock[0].length;
const clockPattern = /(?<![٠-٩۰-۹\d])[٠-٩۰-۹\d]{1,2}:[٠-٩۰-۹\d]{2}(?:\s*(?:AM|PM))?(?![٠-٩۰-۹\d])|(?<![٠-٩۰-۹\d])[٠-٩۰-۹\d]{1,2}\s*(?:AM|PM)\b|(?<![٠-٩۰-۹\d])[٠-٩۰-۹\d]{1,2}h(?:[٠-٩۰-۹\d]{2})?\b/giu;
function canonicalClock(clock:ClockSpan):string|null {
  const matched=ascii(clock[0]).match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(AM|PM)|h(\d{2})?)?$/iu);
  if(!matched)return null;
  let hour=Number(matched[1]);
  if(matched[3])hour=(hour%12)+(matched[3].toUpperCase()==="PM"?12:0);
  return String(hour).padStart(2,"0")+":"+(matched[2]??matched[4]??"00");
}

function timeRole(text:string, clock:ClockSpan):TimeRole|null {
  const prefix=text.slice(0,clock.index);
  const sentenceStart=Math.max(prefix.lastIndexOf("\n"),prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),prefix.lastIndexOf("?"),prefix.lastIndexOf(";"))+1;
  const phrase=text.slice(sentenceStart,clock.index);
  // In an opening-hours range the second endpoint is closing time, even
  // though "open" remains the closest action verb: "open from 8 to 5".
  const precedingClocks=[...phrase.matchAll(clockPattern)] as ClockSpan[];
  const previous=precedingClocks.at(-1);
  if(previous){
    const between=phrase.slice(previous.index+previous[0].length);
    const beforeFirst=phrase.slice(0,previous.index);
    if(/\bto\s*$/iu.test(between)&&
      /\b(?:open|opens|opening|abrimos|abre|abren)\s+from\s*$/iu.test(beforeFirst))
      return "close";
  }
  // EN/ES/AR owner prose is free-form. Recognize common shift paraphrases
  // and localized hours, but never exempt an unrecognized business clock.
  const actions=[...phrase.matchAll(
    /\b(?:shift\s+(?:starts?|begins?|ends?|finishes?)|(?:starts?|begins?|ends?|finishes?)\s+(?:his|her|their|the|a)\s+(?:[\p{L}]+\s+){0,3}shift|(?:open|opens|opening|close|closes|closing|abrimos|abre|abren|abrir|apertura|cerramos|cierra|cierran|cerrar|cierre))\b|\bturno\b[^.!?;\n]{0,30}\b(?:empieza|comienza|inicia|termina|finaliza)\b|(?:نفتح|يفتح|تفتح|نغلق|يغلق|تغلق|الإغلاق|إغلاق|الافتتاح|وردية[^.!?;\n]{0,30}(?:تبدأ|تنتهي|يبدأ|ينتهي)|مناوبة[^.!?;\n]{0,30}(?:تبدأ|تنتهي|يبدأ|ينتهي))/giu
  )];
  const last=actions.at(-1)?.[0]?.toLowerCase()??"";
  if(!last)return null;
  if(/\b(?:shift|turno)\b|(?:وردية|مناوبة)/iu.test(last))
    return /\b(?:ends?|finishes?|termina|finaliza)\b|(?:تنتهي|ينتهي)/iu.test(last)?"shiftEnd":"shiftStart";
  if(/^(?:open|abr|apertura)|(?:نفتح|يفتح|تفتح|الافتتاح)/iu.test(last))return "open";
  if(/^(?:clos|cerr|cierre)|(?:نغلق|يغلق|تغلق|الإغلاق|إغلاق)/iu.test(last))return "close";
  return null;
}
function mentionedWeekdays(text:string,clock:ClockSpan,clocks:ClockSpan[]):string[] {
  const prefix=text.slice(0,clock.index);
  const sentenceStart=Math.max(prefix.lastIndexOf("\n"),prefix.lastIndexOf("."),prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),prefix.lastIndexOf(";"))+1;
  const suffix=text.slice(clockEnd(clock));
  const nextStop=suffix.search(/[.!?;\n]/u);
  const sentenceEnd=nextStop<0?text.length:clockEnd(clock)+nextStop;
  const prev=clocks.filter(m=>m.index<clock.index&&m.index>=sentenceStart).at(-1);
  const next=clocks.find(m=>m.index>clock.index&&m.index<sentenceEnd);
  const beforeStart=prev?clockEnd(prev):sentenceStart;
  const afterEnd=next?next.index:sentenceEnd;
  const mentions=(part:string,offset:number)=>{
    const found:Array<{day:string;start:number;end:number}>=[];
    for(const d of DAY_MENTIONS){
      for(const m of part.matchAll(new RegExp(d.pattern.source,"giu")))
        found.push({day:d.key,start:offset+m.index,end:offset+m.index+m[0].length});
    }
    return found.sort((a,b)=>a.start-b.start);
  };
  const before=mentions(text.slice(beforeStart,clock.index),beforeStart);
  const after=mentions(text.slice(clockEnd(clock),afterEnd),clockEnd(clock));
  const nearestBefore=before.length?clock.index-before[before.length-1].end:Infinity;
  const nearestAfter=after.length?after[0].start-clockEnd(clock):Infinity;
  // Names following one clock belong to that clock, not to the next clock.
  // Prefer a closer preceding weekday for "Monday at 8 and Tuesday at 9".
  const selected=nearestAfter<=nearestBefore?after:before;
  return [...new Set(selected.map(m=>m.day))];
}
type ShiftPersonClaim = {kind:"general"}|{kind:"named";name:string}|{kind:"unresolved"};
// Candidate captures intentionally include a possible second name word. Trim
// sentence connectors/weekdays instead of turning "Monday Ada" or "Ada on"
// into a different employee identity. Preserve genuine two-word names.
function normalizedEmployeeName(raw:string):string {
  const connectors=new Set(["on","for","the","at","in","by","of","a","an","de","el","la"]);
  const weekdays=new Set(["monday","tuesday","wednesday","thursday","friday","saturday",
    "sunday","mon","tue","wed","thu","fri","sat","sun","lunes","martes","miércoles",
    "miercoles","jueves","viernes","sábado","sabado","domingo"]);
  const parts=raw.trim().toLocaleLowerCase().split(/\s+/u);
  while(parts.length>1&&(connectors.has(parts[0])||weekdays.has(parts[0])))parts.shift();
  while(parts.length>1&&(connectors.has(parts.at(-1)??"")||weekdays.has(parts.at(-1)??"")))parts.pop();
  return parts.join(" ");
}
function assertedShiftPerson(text:string,clock:ClockSpan):ShiftPersonClaim {
  const prefix=text.slice(0,clock.index);
  const start=Math.max(prefix.lastIndexOf("\n"),prefix.lastIndexOf("."),prefix.lastIndexOf(";"))+1;
  const suffix=text.slice(clockEnd(clock));
  const endOffset=suffix.search(/[.!?;\n]/u);
  const sentenceEnd=endOffset<0?text.length:clockEnd(clock)+endOffset;
  const before=text.slice(start,clock.index), after=text.slice(clockEnd(clock),sentenceEnd);
  // Preserve the named person across qualifiers such as "Bob's morning
  // shift" and after-the-clock "shift ... for Bob" constructions.
  const possessive=[...before.matchAll(/([\p{L}\p{M}]+(?:[ \t-]+[\p{L}\p{M}]+)?)['’]s\s+(?:[\p{L}\p{M}\d-]+\s+){0,5}shift\b/giu)].at(-1);
  if(possessive)return {kind:"named",name:normalizedEmployeeName(possessive[1])};
  const subject=[...before.matchAll(/(?:^|[^\p{L}\p{M}])([\p{L}\p{M}]+(?:[ \t-]+[\p{L}\p{M}]+)?)\s+(?:starts?|begins?|ends?|finishes?)\s+(?:his|her|their)\s+(?:[\p{L}\p{M}]+\s+){0,3}shift\b/giu)].at(-1);
  if(subject)return {kind:"named",name:normalizedEmployeeName(subject[1])};
  const forPerson=(before+" "+after).match(/\bfor\s+([\p{L}\p{M}]+(?:[ \t-]+[\p{L}\p{M}]+)?)/iu);
  if(forPerson)return {kind:"named",name:normalizedEmployeeName(forPerson[1])};
  // If this is explicitly someone's shift but the name could not be parsed,
  // fail closed instead of silently treating the claim as any employee.
  if(/['’]s[^.!?;\n]{0,90}\bshift\b|\bfor\s+\S+/iu.test(before+" "+after))
    return {kind:"unresolved"};
  return {kind:"general"};
}
const CALENDAR_MONTHS:Record<string,number>={
  january:1,jan:1,enero:1,يناير:1, february:2,feb:2,febrero:2,فبراير:2,
  march:3,mar:3,marzo:3,مارس:3, april:4,apr:4,abril:4,أبريل:4,ابريل:4,
  may:5,mayo:5,مايو:5, june:6,jun:6,junio:6,يونيو:6,
  july:7,jul:7,julio:7,يوليو:7, august:8,aug:8,agosto:8,أغسطس:8,اغسطس:8,
  september:9,sep:9,sept:9,septiembre:9,setiembre:9,سبتمبر:9,
  october:10,oct:10,octubre:10,أكتوبر:10,اكتوبر:10,
  november:11,nov:11,noviembre:11,نوفمبر:11,
  december:12,dec:12,diciembre:12,ديسمبر:12
};
const MONTH_LABEL=Object.keys(CALENDAR_MONTHS).join("|");
function isoCalendarDate(year:number,month:number,day:number):string|null{
  if(year<1900||year>2100||month<1||month>12||day<1||day>31)return null;
  const d=new Date(Date.UTC(year,month-1,day));
  if(d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==day)return null;
  return d.toISOString().slice(0,10);
}
/** undefined = no asserted date; null = asserted but unparsable date. */
function parseCalendarReference(raw:string):string|null|undefined {
  const clause=ascii(raw);
  const iso=clause.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/u);
  if(iso)return isoCalendarDate(Number(iso[1]),Number(iso[2]),Number(iso[3]));
  // Short slash dates are locale-ambiguous; keep the clock unverified.
  if(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/u.test(clause))return null;
  const months=new RegExp("("+MONTH_LABEL+")","iu");
  if(!months.test(clause))return undefined;
  const forward=clause.match(new RegExp("("+MONTH_LABEL+")\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})","iu"));
  if(forward)return isoCalendarDate(Number(forward[3]),CALENDAR_MONTHS[forward[1].toLocaleLowerCase()],Number(forward[2]));
  const reverse=clause.match(new RegExp("(\\d{1,2})\\s+(?:de\\s+)?("+MONTH_LABEL+")\\s+(?:de\\s+)?(\\d{4})","iu"));
  if(reverse)return isoCalendarDate(Number(reverse[3]),CALENDAR_MONTHS[reverse[2].toLocaleLowerCase()],Number(reverse[1]));
  return null;
}
function claimedClockDate(text:string,clock:ClockSpan,clocks:ClockSpan[]):string|null|undefined{
  const prior=text.slice(0,clock.index);
  const sentenceStart=Math.max(prior.lastIndexOf("\n"),prior.lastIndexOf("."),
    prior.lastIndexOf("!"),prior.lastIndexOf("?"),prior.lastIndexOf(";"))+1;
  const endAfter=text.slice(clockEnd(clock)).search(/[.!?;\n]/u);
  const sentenceEnd=endAfter<0?text.length:clockEnd(clock)+endAfter;
  const previous=clocks.filter(c=>c.index<clock.index&&c.index>=sentenceStart).at(-1);
  const next=clocks.find(c=>c.index>clock.index&&c.index<sentenceEnd);
  const local=parseCalendarReference(text.slice(previous?clockEnd(previous):sentenceStart,
    next?next.index:sentenceEnd));
  if(local!==undefined)return local;
  // One trailing calendar qualifier can apply to both start and end clocks
  // in a single shift assertion; don't silently treat the first as undated.
  return parseCalendarReference(text.slice(sentenceStart,sentenceEnd));
}

function observedHours(results:readonly AgentToolResult[]):VerifiedTime[] {
  const known:VerifiedTime[]=[];
  for(const r of results){
    if(!/hours/.test(r.source))continue;
    const raw=r.hours??r.weekly;
    if(!raw||typeof raw!=="object"||Array.isArray(raw))continue;
    for(const day of DAY_MENTIONS.map(d=>d.key)){
      const intervals=(raw as Record<string,unknown>)[day];
      if(!Array.isArray(intervals))continue;
      for(const interval of intervals){
        if(!Array.isArray(interval)||interval.length!==2)continue;
        for(const [i,role] of (["open","close"] as const).entries()){
          const time:unknown=interval[i];
          if(typeof time==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))
            known.push({day,time,role,complete:r.missing.length===0,person:null});
        }
      }
    }
  }
  return known;
}
function observedShifts(results:readonly AgentToolResult[]):VerifiedTime[] {
  const known:VerifiedTime[]=[];
  for(const r of results){
    if(r.source!=="recurring_schedule"||!Array.isArray(r.shifts))continue;
    for(const shift of r.shifts){
      if(!shift||typeof shift!=="object")continue;
      const s=shift as Record<string,unknown>;
      if(typeof s.dayOfWeek!=="number"||!Number.isInteger(s.dayOfWeek))continue;
      const day=DAY_MENTIONS[s.dayOfWeek]?.key;
      if(!day)continue;
      const person=typeof s.displayName==="string"?s.displayName.trim().toLocaleLowerCase():null;
      const periodFrom=typeof r.period?.from==="string"?r.period.from:null;
      const periodTo=typeof r.period?.to==="string"?r.period.to:null;
      const activeFrom=typeof s.effectiveFrom==="string"?s.effectiveFrom:null;
      const activeTo=typeof s.effectiveTo==="string"?s.effectiveTo:null;
      const validFrom=[periodFrom,activeFrom].filter((x):x is string=>x!==null).sort().at(-1);
      const validTo=[periodTo,activeTo].filter((x):x is string=>x!==null).sort()[0];
      for(const [field,role] of [["startTime","shiftStart"],["endTime","shiftEnd"]] as const){
        const time=s[field];
        if(typeof time==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))
          known.push({day,time,role,complete:r.missing.length===0,person,
            validFrom,validTo});
      }
    }
  }
  return known;
}

/** Report unsupported numbers at their original prose offsets; never change the owner's text. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale,
  previousEvidence:readonly NumericEvidence[] = []): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  // Merge prior and current tool observations *before* authorizing values.
  // A partial refresh of Latte's 850-cent price supersedes 600 cents even
  // when other menu items were truncated or remain unknown.
  const evidence=reconcileSavedEvidence([...previousEvidence,...compactEvidence(results,Infinity)]);
  for(const entry of evidence){
    for(const v of entry.values.slice(0,100)){
      if(!Number.isFinite(v.value))continue;
      if(v.unit==="cents")allowed.money.add(v.value);
      if(v.unit==="bps")allowed.percent.add(v.value);
      if(v.unit==="ratio")allowed.percent.add(Math.round(v.value*10000));
      if(v.unit==="count"&&trustedCountKey(v.key))allowed.number.add(v.value);
    }
  }
  const menuPrices=evidence.filter(e=>e.tool==="menu_items").flatMap(e=>e.prices??[]);
  const ownerNumbers=candidates(ownerText,locale);
  ownerNumbers.forEach(v=>allowed[v.kind].add(v.value));
  // Assistant prose is NEVER numeric evidence, even if it had no unverified
  // chips. Clock formatting and list markers can pass without a source.
  // Only owner statements and typed tool evidence can authorize a claim.
  // Explicit owner-provided quantities are not prices. Infer dollars only from
  // a nearby monetary / menu-price statement, never from "sold 9 drinks".
  for(const v of ownerNumbers){
    if(v.kind!=="number")continue;
    const before=ownerText.slice(Math.max(0,v.start-90),v.start);
    const after=ownerText.slice(v.end,v.end+24);
    if(/^\s*(?:drinks?|orders?|people|staff|items?|cups?|units?|hours?|days?|coffees?)\b/iu.test(after))continue;
    if(/\b(?:price|cost|charge|rent|bill|fee|salary|wage|revenue|profit|latte|mocha|espresso|cappuccino|americano|tea|coffee|sandwich|croissant|muffin|brownie)\b[^.!?\n]{0,45}$/iu.test(before))
      allowed.money.add(Math.round(v.value*100));
  }
  // Monetary evidence stays in cents. Check currency-less monetary wording
  // at each candidate, rather than authorizing the value as a generic count.

  // No reply-wide arithmetic closure. Any new business calculation belongs
  // in lib/calc and must be tied to the claim's specific metric/source.
  const observed=evidence.flatMap(entry=>entry.times??[]);
  // Only this clock's offsets, action, day(s), and named employee may match a
  // real source interval. Never flatten schedule timestamps into global proof.
  const clocks = [...text.matchAll(clockPattern)] as ClockSpan[];
  const ownerClocks = [...ownerText.matchAll(clockPattern)] as ClockSpan[];
  return candidates(text, locale).filter(v => {
    if(v.kind==="number" && isListMarker(text,v.start,v.end,v.value))return false;
    const clock = v.kind==="number" ? clocks.find(m =>
      v.start < clockEnd(m) && v.end > m.index) : undefined;
    if(clock){
      const role=timeRole(text,clock);
      if(!role){
        // Sales prose may include incidental timestamps (e.g. "999 (8:00)");
        // do not mistake the clock for the adjacent sale count. But any
        // recognizably business-time assertion must fail closed on an
        // unrecognized action, in every supported language.
        const prior=text.slice(0,clock.index);
        const sentenceStart=Math.max(prior.lastIndexOf("\n"),prior.lastIndexOf("."),
          prior.lastIndexOf("!"),prior.lastIndexOf("?"),prior.lastIndexOf(";"))+1;
        const sentence=text.slice(sentenceStart);
        return /\b(?:open|opening|opens|close|closing|closes|hours|shift|starts?|ends?|begins?|finishes?|abrimos|abrir|abre|abren|apertura|cerramos|cerrar|cierra|cierre|turno)\b|(?:نفتح|نغلق|يفتح|يغلق|وردية|مناوبة|الافتتاح|الإغلاق)/iu.test(sentence);
      }
      const canonical=canonicalClock(clock);
      if(canonical){
        const days=mentionedWeekdays(text,clock,clocks);
        const claimedDate=claimedClockDate(text,clock,clocks);
        const calendarDay=claimedDate?DAY_MENTIONS[new Date(claimedDate+"T12:00:00Z").getUTCDay()]?.key:null;
        const dateAgrees=claimedDate!==null&&
          (!claimedDate||days.length===0||days.includes(calendarDay??""));
        const person=role.startsWith("shift")?assertedShiftPerson(text,clock):{kind:"general" as const};
        const verified=dateAgrees&&person.kind!=="unresolved"&&(days.length?days:[null]).every(day=>observed.some(h=>
          h.time===canonical&&h.role===role&&(day===null?h.complete:h.day===day)&&
          (!claimedDate||h.day===calendarDay)&&
          (!claimedDate||(!h.validFrom||claimedDate>=h.validFrom)&&(!h.validTo||claimedDate<=h.validTo))&&
          (person.kind==="general"||(person.kind==="named"&&h.person===person.name))));
        // Owner words also need the same asserted time *role*, weekday and
        // named employee. Matching a bare "8:00" cannot prove opening hours
        // when the owner only described an employee shift.
        const ownerGrounded=ownerClocks.some(ownerClock=>{
          if(timeRole(ownerText,ownerClock)!==role||canonicalClock(ownerClock)!==canonical)return false;
          const ownerDays=mentionedWeekdays(ownerText,ownerClock,ownerClocks);
          if(days.length&&!days.every(day=>ownerDays.includes(day)))return false;
          const ownerDate=claimedClockDate(ownerText,ownerClock,ownerClocks);
          if(claimedDate===null||ownerDate===null)return false;
          if(claimedDate&&ownerDate!==claimedDate)return false;
          const ownerPerson=role.startsWith("shift")?assertedShiftPerson(ownerText,ownerClock):{kind:"general" as const};
          if(person.kind==="unresolved"||ownerPerson.kind==="unresolved")return false;
          return person.kind==="general"||
            (person.kind==="named"&&ownerPerson.kind==="named"&&ownerPerson.name===person.name);
        });
        return !(verified||ownerGrounded);
      }
      return true;
    }
    const supported = [...allowed[v.kind]].some(x =>
      Math.abs(x - v.value) <= (v.kind === "money" ? 1 : v.kind === "percent" ? v.wholePercent ? 50 : 10 : 0));
    if (supported) return false;
    if(v.kind==="money"&&verifiedMenuDifference(text,v.start,v.end,v.value,menuPrices))return false;
    // Never promote a money amount into count evidence, even for saved reads.
    if (v.kind === "number" && isCurrencylessMoneyClaim(text, v.start, v.end))
      return ![...allowed.money].some(cents => Math.abs(cents - Math.round(v.value * 100)) <= 1);
    return true;
  })
    .map(({ text: token, start, end, kind }) => ({ text: token, start, end, kind }));
}
