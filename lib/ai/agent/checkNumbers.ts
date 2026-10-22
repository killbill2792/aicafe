import type { AgentLocale, AgentToolResult } from "./tools";

export type NumericEvidence = {tool:string;values:Array<{key:string;value:number;unit:"cents"|"bps"|"ratio"|"count"}>};
// Only business collections, not diagnostics or metadata, establish counts.
// This same contract applies to current-turn and persisted numeric evidence.
const COUNTABLE_COLLECTIONS = new Set(["items","people","shifts","laborDays","days","categories","attendanceRecords"]);
const NON_EVIDENCE_FIELDS = new Set(["source","agentId","labels","period","date",
  "missing","estimated","warnings","stale","quality","missingInputs","estimatedInputs","staleInputs"]);

export function compactEvidence(results:readonly AgentToolResult[]):NumericEvidence[]{
  let remaining=100;
  return results.map(r=>{
    const values:NumericEvidence["values"]=[];
    const periodKey=r.period?r.period.from+"/"+r.period.to+"/":"";
    const walk=(v:unknown,key:string,depth:number,scope="")=>{
      if(remaining<=0||depth>6||NON_EVIDENCE_FIELDS.has(key))return;
      if(Array.isArray(v)){
        if(COUNTABLE_COLLECTIONS.has(key)&&remaining>0){
          values.push({key:periodKey+scope+key+"Length",value:v.length,unit:"count"});remaining--;
        }
        for(const item of v){
          if(remaining<=0)break;
          const scoped=item&&typeof item==="object"&&!Array.isArray(item)&&"id" in item&&
            typeof item.id==="string"?scope+key+":"+item.id+"/":scope;
          walk(item,key,depth+1,scoped);
        }
        return;
      }
      if(v&&typeof v==="object"){
        for(const [k,item] of Object.entries(v))walk(item,k,depth+1,scope);
        return;
      }
      if(typeof v!=="number"||!Number.isFinite(v))return;
      const unit=/Cents$|Micros$/.test(key)?"cents":/Bps$|Percent$/.test(key)?"bps":
        /Margin$|Ratio$/.test(key)?"ratio":"count";
      const value=/Micros$/.test(key)?v/1000000:/Percent$/.test(key)?v*100:v;
      values.push({key:periodKey+scope+key,value,unit});remaining--;
    };
    if(r.missing.length===0)walk(r,"",0);
    return {tool:r.source,values};
  }).filter(x=>x.values.length>0);
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

function allowFromData(data: unknown, allowed: Record<Kind, Set<number>>, key = ""): void {
  if (NON_EVIDENCE_FIELDS.has(key)) return;
  if (Array.isArray(data)) {
    if (COUNTABLE_COLLECTIONS.has(key)) allowed.number.add(data.length);
    data.forEach(v => allowFromData(v, allowed, key));
    return;
  }
  if (data && typeof data === "object") {
    for (const [k,v] of Object.entries(data)) {
      if (NON_EVIDENCE_FIELDS.has(k)) continue;
      allowFromData(v, allowed, k);
    }
    return;
  }
  if (typeof data !== "number" || !Number.isFinite(data)) return;
  if (/Cents$/.test(key)) allowed.money.add(Math.round(data));
  else if (/Micros$/.test(key)) allowed.money.add(data/1000000);
  else if (/Percent$/.test(key)) allowed.percent.add(Math.round(data*100));
  else if (/Bps$/.test(key)) allowed.percent.add(Math.round(data));
  else if (/Margin$|Ratio$/.test(key)) allowed.percent.add(Math.round(data * 10000));
  else allowed.number.add(data);
}
/** Report unsupported numbers at their original prose offsets; never change the owner's text. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale,
  previousEvidence:readonly NumericEvidence[] = [], previousAssistantText = ""): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  results.forEach(r => allowFromData(r, allowed));
  // A successful read of a source supersedes every older claim from that
  // source. Fail closed for legacy saved evidence lacking item/period keys.
  const freshSources=new Set(results.filter(r=>r.missing.length===0).map(r=>r.source));
  for(const e of previousEvidence){
    if(freshSources.has(e.tool))continue;
    for(const v of e.values.slice(0,100)){
      if(!Number.isFinite(v.value))continue;
      if(v.unit==="cents")allowed.money.add(v.value);
      if(v.unit==="bps")allowed.percent.add(v.value);
      if(v.unit==="ratio")allowed.percent.add(Math.round(v.value*10000));
      if(v.unit==="count")allowed.number.add(v.value);
    }
  }
  const ownerNumbers=candidates(ownerText,locale);
  ownerNumbers.forEach(v=>allowed[v.kind].add(v.value));
  // Earlier assistant text has no item-level source map. Never use it to
  // override new evidence; retained typed evidence remains valid across no-read turns.
  if(freshSources.size===0)
    candidates(previousAssistantText,locale).forEach(v=>allowed[v.kind].add(v.value));
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

  // Derived amounts are supported only by same-unit pairs, never by arbitrary cross-unit arithmetic.
  for(const kind of ["money","percent","number"] as const){
    const source=[...allowed[kind]].slice(0,60);
    for(let i=0;i<source.length;i++)for(let j=0;j<source.length;j++){
      if(i===j)continue;
      const a=source[i],b=source[j];
      if(/\b(?:more than|less than|difference|increase|decrease|higher|lower|change|extra|combined|total of)\b/i.test(text)){
        allowed[kind].add(a+b);allowed[kind].add(a-b);
      }

    }
  }
  const knownTimes = results.filter(r=>r.missing.length===0&&/hours|schedule/.test(r.source))
    .map(r=>JSON.stringify(r)).join(" ");
  // Clock tokens are formatting only for their *own* numeric spans. A nearby
  // time must never exempt an unrelated sale, staffing, or monetary number.
  const clocks = [...text.matchAll(/(?<!\d)\d{1,2}:\d{2}(?:\s*(?:AM|PM))?(?!\d)|(?<!\d)\d{1,2}\s*(?:AM|PM)\b|(?<!\d)\d{1,2}h(?:\d{2})?\b/giu)];
  const businessTimeClaim = /\b(?:we\s+open|we\s+close|open\s+at|close\s+at|shift\s+(?:starts|ends)|business\s+hours)\b/iu.test(text);
  return candidates(text, locale).filter(v => {
    if(v.kind==="number" && isListMarker(text,v.start,v.end,v.value))return false;
    const clock = v.kind==="number" ? clocks.find(m =>
      v.start < m.index + m[0].length && v.end > m.index) : undefined;
    if(clock){
      if(!businessTimeClaim)return false;
      const matched=clock[0].match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(AM|PM)|h(\d{2})?)?$/iu);
      if(matched){
        let hour=Number(matched[1]);
        if(matched[3])hour=(hour%12)+(matched[3].toUpperCase()==="PM"?12:0);
        const canonical=String(hour).padStart(2,"0")+":"+(matched[2]??matched[4]??"00");
        return !(knownTimes.includes(canonical)||ownerText.includes(clock[0])||ownerText.includes(canonical));
      }
      return true; // Unparseable business-hour claims remain unverified.
    }
    const supported = [...allowed[v.kind]].some(x =>
      Math.abs(x - v.value) <= (v.kind === "money" ? 1 : v.kind === "percent" ? v.wholePercent ? 50 : 10 : 0));
    if (supported) return false;
    // Never promote a money amount into count evidence, even for saved reads.
    if (v.kind === "number" && isCurrencylessMoneyClaim(text, v.start, v.end))
      return ![...allowed.money].some(cents => Math.abs(cents - Math.round(v.value * 100)) <= 1);
    return true;
  })
    .map(({ text: token, start, end, kind }) => ({ text: token, start, end, kind }));
}
