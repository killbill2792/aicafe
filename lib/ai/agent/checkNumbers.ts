import type { AgentLocale, AgentToolResult } from "./tools";

export type NumericEvidence = {tool:string;values:Array<{key:string;value:number;unit:"cents"|"bps"|"ratio"|"count"}>};
export function compactEvidence(results:readonly AgentToolResult[]):NumericEvidence[]{
  let remaining=100;
  return results.map(r=>{
    const values:NumericEvidence["values"]=[];
    const walk=(v:unknown,key:string,depth:number)=>{
      if(remaining<=0||depth>6)return;
      if(Array.isArray(v)){for(const item of v){if(remaining<=0)break;walk(item,key,depth+1);}return;}
      if(v&&typeof v==="object"){
        for(const [k,item] of Object.entries(v))walk(item,k,depth+1);
        return;
      }
      if(typeof v!=="number"||!Number.isFinite(v))return;
      const unit=/Cents$/.test(key)?"cents":/Bps$/.test(key)?"bps":
        /Margin$|Ratio$/.test(key)?"ratio":"count";
      values.push({key,value:v,unit});remaining--;
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
function allowFromData(data: unknown, allowed: Record<Kind, Set<number>>, key = ""): void {
  if (Array.isArray(data)) { allowed.number.add(data.length); data.forEach(v => allowFromData(v, allowed, key)); return; }
  if (data && typeof data === "object") {
    for (const [k,v] of Object.entries(data)) {
      if (k === "labels" || k === "period" || k === "date") continue;
      allowFromData(v, allowed, k);
    }
    return;
  }
  if (typeof data !== "number" || !Number.isFinite(data)) return;
  if (/Cents$/.test(key)) allowed.money.add(Math.round(data));
  else if (/Bps$/.test(key)) allowed.percent.add(Math.round(data));
  else if (/Margin$|Ratio$/.test(key)) allowed.percent.add(Math.round(data * 10000));
  else allowed.number.add(data);
}
/** Report unsupported numbers at their original prose offsets; never change the owner's text. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale,
  previousEvidence:readonly NumericEvidence[] = [], previousAssistantText = ""): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  results.forEach(r => allowFromData(r, allowed));
  for(const e of previousEvidence)for(const v of e.values.slice(0,100)){
    if(!Number.isFinite(v.value))continue;
    if(v.unit==="cents")allowed.money.add(v.value);
    if(v.unit==="bps")allowed.percent.add(v.value);
    if(v.unit==="ratio")allowed.percent.add(Math.round(v.value*10000));
    if(v.unit==="count")allowed.number.add(v.value);
  }
  candidates(ownerText+"\n"+previousAssistantText, locale).forEach(v => allowed[v.kind].add(v.value));
  // One monetary amount can be expressed as dollars without a currency symbol; owner numbers can be monetary.
  for(const cents of [...allowed.money])allowed.number.add(cents/100);
  for(const plain of [...allowed.number])allowed.money.add(Math.round(plain*100));
  // Derived amounts are supported only by same-unit pairs, never by arbitrary cross-unit arithmetic.
  for(const kind of ["money","percent","number"] as const){
    const source=[...allowed[kind]].slice(0,60);
    for(let i=0;i<source.length;i++)for(let j=0;j<source.length;j++){
      const a=source[i],b=source[j];
      allowed[kind].add(a+b);allowed[kind].add(a-b);
      if(kind==="money"){
        if(b!==0)allowed.number.add(a/b);
        if(a!==0)allowed.percent.add(Math.round(((b-a)/Math.abs(a))*10000));
      }else if(kind==="number"){
        allowed.number.add(a*b);
        if(b!==0)allowed.number.add(a/b);
      }
    }
  }
  return candidates(text, locale).filter(v => {
    const before=text.slice(0,v.start), after=text.slice(v.end);
    if(v.kind==="number" && /(?:^|\s)$/u.test(before) && /^\d+[.)]\s/u.test(text.slice(v.start)))return false;
    if(v.kind==="number" && /^[.)]\s/u.test(after) && /(?:^|\s)$/u.test(before))return false;
    const local=text.slice(Math.max(0,v.start-5),Math.min(text.length,v.end+7));
    if(v.kind==="number" && (/\d{1,2}:\d{2}/u.test(local) || /\b\d{1,2}\s*(?:AM|PM)\b/iu.test(local) ||
      /\b\d{1,2}h(?:\d{2})?\b/iu.test(local)))return false;
    if(v.kind==="number"&&Number.isInteger(v.value)&&v.value>=0&&v.value<=12&&!/^(?:\\s*)(?:drinks?|items?|orders?|staff|people|hours?|days?|oz|cups?|units?)/iu.test(after))return false;
    return ![...allowed[v.kind]].some(x =>
    Math.abs(x - v.value) <= (v.kind === "money" ? 1 : v.kind === "percent" ? v.wholePercent ? 50 : 10 : 0));
  })
    .map(({ text: token, start, end, kind }) => ({ text: token, start, end, kind }));
}
