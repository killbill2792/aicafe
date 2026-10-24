import { tokenizeNumbers } from "./numberTokens";
import type { AgentLocale, AgentToolResult } from "./tools";
import { menuPriceDifferenceCents } from "@/lib/calc/agentPriceDifferences";
import { metricCatalog,metricKeySchema } from "@/lib/calc/metrics/catalog";
import { sumCents } from "@/lib/calc/money";

export type MenuPrice = {id:string;name:string;priceCents:number};
export type TimeScope = {kind:"hours";days:string[]} | {kind:"schedule";from:string;to:string;exhaustive?:boolean};
export type NumericEvidence = {tool:string;values:Array<{key:string;value:number;unit:"cents"|"bps"|"ratio"|"count";
  provenance?:"estimate";detail?:"breakEvenSales"|"salesGap"|"dailyOverhead"}>;
  times?:VerifiedTime[];timeScope?:TimeScope;prices?:MenuPrice[];
  invalidatedKeys?:string[];invalidatedPriceIds?:string[];
  priceUpdates?:Array<{id:string;priceCents:number}>};
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

/** Initiative detail has generic "current / baseline / target / value" fields.
 * They are not evidence until their metric identity, catalog unit and
 * completeness are validated. Never scan arbitrary objects for numeric facts.
 */
function appendInitiativeNumericEvidence(
  result:AgentToolResult,
  values:NumericEvidence["values"],invalidatedKeys:string[],
):void {
  if(result.source!=="owner_initiatives"||!result.metricDetail||
    typeof result.metricDetail!=="object"||Array.isArray(result.metricDetail)||
    !result.initiative||typeof result.initiative!=="object"||
    Array.isArray(result.initiative))return;
  const detail=result.metricDetail as Record<string,unknown>;
  const initiative=result.initiative as Record<string,unknown>;
  const keyParsed=metricKeySchema.safeParse(detail.metricKey);
  if(!keyParsed.success||detail.source!=="computed"||
    typeof initiative.id!=="string"||typeof detail.id!=="string"||
    !detail.params||typeof detail.params!=="object"||
    !metricCatalog[keyParsed.data].paramsSchema.safeParse(detail.params).success)return;
  const unit=metricCatalog[keyParsed.data].unit;
  if(detail.unit!==unit||unit==="microcents_per_base_unit")return;
  const metricRoot="initiative:"+initiative.id+"/metric:"+detail.id+"/key:"+keyParsed.data+"/";
  // Relative improvement targets are themselves percentages, not an
  // implicit dollar/count threshold. Treat the owner's approved spec as
  // typed percentage evidence, separate from the computed test target.
  const relativeKey=metricRoot+"relativeChangeBps";
  invalidatedKeys.push(relativeKey);
  if(detail.targetKind==="relative_pct"&&
    typeof detail.target==="number"&&Number.isFinite(detail.target))
    values.push({key:relativeKey,value:detail.target*100,unit:"bps"});
  const keyFor=(field:string,date?:string)=>
    metricRoot+(date?"day:"+date+"/":"")+field+
      (unit==="count"?"/count":unit==="cents"?"Cents":unit==="bps"?"Bps":"Ratio");
  const add=(field:string,raw:unknown,covered=true,date?:string)=>{
    const key=keyFor(field,date);
    invalidatedKeys.push(key);
    if(!covered||typeof raw!=="number"||!Number.isFinite(raw))return;
    values.push({key,value:raw,unit});
  };
  const evaluation=result.metricEvaluation;
  const ev=evaluation&&typeof evaluation==="object"&&!Array.isArray(evaluation)?
    evaluation as Record<string,unknown>:null;
  const covered=ev?.coverage!==undefined&&typeof ev.coverage==="number"&&
    ev.coverage>=0.8;
  // A stated absolute goal threshold is verified even before evaluation.
  // A relative-pct spec is not a currency or count; its computed comparison
  // target becomes numeric evidence only when an evaluation exists.
  add("current",ev?.current,covered);
  add("baseline",ev?.baseline,covered);
  add("target",ev?.target??(detail.targetKind==="absolute"?detail.target:null),
    ev?covered:detail.targetKind==="absolute");
  const obs=result.observation;
  if(obs&&typeof obs==="object"&&!Array.isArray(obs)){
    const row=obs as Record<string,unknown>;
    if(row.metricId===detail.id&&typeof row.date==="string"&&
      /^\d{4}-\d{2}-\d{2}$/u.test(row.date)){
      add("observation",row.value,typeof row.coverage==="number"&&
        row.coverage>=0.8,row.date);
    }
  }
}

/** Collect the complete current observations first. Apply the persistence cap
 * only after collection, prioritizing recent reads and high-value prices. */
export function compactEvidence(results:readonly AgentToolResult[],limit=100):NumericEvidence[]{
  const gathered=results.map(r=>{
    const values:NumericEvidence["values"]=[];
    const invalidatedKeys:string[]=[];
    const periodKey=r.period?r.period.from+"/"+r.period.to+"/":"";
    const rootId=typeof r.itemId==="string"?r.itemId:null;
    const rootScope=rootId?"item:"+rootId+"/":"";
    const walk=(v:unknown,key:string,depth:number,scope="")=>{
      if(depth>6||NON_EVIDENCE_FIELDS.has(key))return;
      if(Array.isArray(v)){
        if(COUNTABLE_COLLECTIONS.has(key)){
          const lengthKey=periodKey+scope+key+"Length";
          invalidatedKeys.push(lengthKey);
          values.push({key:lengthKey,value:v.length,unit:"count"});
        }
        for(const item of v){
          const scoped=item&&typeof item==="object"&&!Array.isArray(item)&&"id" in item&&
            typeof item.id==="string"?scope+key+":"+item.id+"/":
            item&&typeof item==="object"&&!Array.isArray(item)&&
              key==="days"&&"date" in item&&typeof item.date==="string"?
              scope+"day:"+item.date+"/":scope;
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
      const valueKey=periodKey+scope+key;
      if(v===null && (/Cents$|Micros$|Bps$|Percent$|Margin$|Ratio$/u.test(key)||
        COUNTABLE_FIELDS.has(key))) {
        invalidatedKeys.push(valueKey);return;
      }
      if(typeof v!=="number"||!Number.isFinite(v))return;
      const unit=/Cents$|Micros$/.test(key)?"cents":/Bps$|Percent$/.test(key)?"bps":
        /Margin$|Ratio$/.test(key)?"ratio":COUNTABLE_FIELDS.has(key)?"count":null;
      if(!unit)return;
      invalidatedKeys.push(valueKey);
      values.push({key:valueKey,value:/Micros$/.test(key)?v/1000000:/Percent$/.test(key)?v*100:v,unit});
    };
    walk(r,"",0,rootScope);
    // A computed amount must remain an estimate in evidence saved for later
    // conversational turns. Match both the trusted comparison and its declared
    // numberEstimates metadata; never mark unrelated numerically equal values.
    if(r.source==="break_even"&&r.ownerComparison&&
      typeof r.ownerComparison==="object"&&!Array.isArray(r.ownerComparison)&&
      Array.isArray(r.numberEstimates)){
      const comparison=r.ownerComparison as Record<string,unknown>;
      for(const [key,detail] of [
        ["dailyBreakEvenSalesCents","breakEvenSales"],
        ["dailyShortfallCents","salesGap"],
        ["dailyFixedCostsCents","dailyOverhead"],
      ] as const){
        const amount=comparison[key];
        if(typeof amount!=="number"||!Number.isSafeInteger(amount)||
          !r.numberEstimates.some(item=>item&&typeof item==="object"&&
            item.unit==="cents"&&item.value===amount&&item.detail===detail))continue;
        const observed=values.find(v=>v.key===periodKey+rootScope+key&&
          v.unit==="cents"&&v.value===amount);
        if(observed){observed.provenance="estimate";observed.detail=detail;}
      }
    }
    appendInitiativeNumericEvidence(r,values,invalidatedKeys);
    const times=[...observedHours([r]),...observedShifts([r])].slice(0,60);
    let timeScope:TimeScope|undefined;
    if(r.source==="locations.open_hours"){
      // Successful partial configuration explicitly invalidates the days
      // listed as unset; a network/reader failure does not.
      const present=r.hours&&typeof r.hours==="object"&&!Array.isArray(r.hours)
        ? DAY_MENTIONS.map(d=>d.key).filter(d=>Object.hasOwn(r.hours as object,d)) : [];
      const unset=r.missing.filter(x=>/^businessHoursNotSet:(?:sun|mon|tue|wed|thu|fri|sat)$/u.test(x))
        .map(x=>x.slice("businessHoursNotSet:".length));
      const allUnset=r.hours===null&&r.missing.includes("businessHoursNotSet")
        ? DAY_MENTIONS.map(d=>d.key):[];
      const days=[...new Set([...present,...unset,...allUnset])];
      if(days.length)timeScope={kind:"hours",days};
    }
    // A failed schedule read is not an empty observed schedule. Clear an
    // existing window only if a successful reader explicitly returned shifts.
    if(r.source==="recurring_schedule"&&Array.isArray(r.shifts)&&r.period?.from&&r.period?.to)
      timeScope={kind:"schedule",from:r.period.from,to:r.period.to,
        exhaustive:!r.missing.includes("scheduleResultTruncated")};
    const prices:MenuPrice[]=[];
    const invalidatedPriceIds:string[]=[];
    const priceUpdates:Array<{id:string;priceCents:number}>=[];
    const record=(item:unknown)=>{
      if(!item||typeof item!=="object"||Array.isArray(item))return;
      const row=item as Record<string,unknown>;
      if(typeof row.id!=="string")return;
      if(row.priceCents===null){invalidatedPriceIds.push(row.id);return;}
      if(typeof row.name==="string"&&typeof row.priceCents==="number"&&
        Number.isSafeInteger(row.priceCents))
        prices.push({id:row.id,name:row.name,priceCents:row.priceCents});
    };
    if(r.source==="menu_items"&&Array.isArray(r.items))r.items.forEach(record);
    if(r.source==="product_costs")record(r.item);
    // Pricing engine exposes a stable itemId and the CURRENT price; do not
    // substitute its recommendation, or fabricate a display name.
    if(r.source==="pricing_engine"&&typeof r.itemId==="string"){
      if(typeof r.currentPriceCents==="number"&&Number.isSafeInteger(r.currentPriceCents))
        priceUpdates.push({id:r.itemId,priceCents:r.currentPriceCents});
      else if(r.currentPriceCents===null)invalidatedPriceIds.push(r.itemId);
    }
    return {tool:r.source,values,times,timeScope,prices:prices.slice(0,25),
      invalidatedKeys:[...new Set(invalidatedKeys)],invalidatedPriceIds,priceUpdates};
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
    e.timeScope?.kind==="schedule"||e.prices.length>0||
    e.invalidatedKeys.length>0||e.invalidatedPriceIds.length>0||e.priceUpdates.length>0);
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
    prices:Map<string,MenuPrice>;priceUpdates:Array<{id:string;priceCents:number}>}>();
  for(const entry of entries){
    let slot=bySource.get(entry.tool);
    if(!slot){slot={values:new Map(),times:[],prices:new Map(),priceUpdates:[]};bySource.set(entry.tool,slot);}
    const grouped=new Map<string,Value[]>();
    for(const v of entry.values){
      if(typeof v.key!=="string"||!Number.isFinite(v.value))continue;
      const group=grouped.get(v.key)??[];
      group.push(v);grouped.set(v.key,group);
    }
    // Clear all refreshed or explicitly unknown keys, even when the
    // 100-value persistence budget dropped their new values. A failed read
    // exposes no observations and therefore cannot invalidate anything.
    for(const key of entry.invalidatedKeys??[]){
      if(typeof key!=="string")continue;
      slot.values.delete(key);
      if(key.includes("/"))slot.values.delete(key.split("/").at(-1)??"");
    }
    for(const [key,group] of grouped){
      if(key.includes("/"))slot.values.delete(key.split("/").at(-1)??"");
      slot.values.set(key,group);
    }
    for(const id of entry.invalidatedPriceIds??[])
      if(typeof id==="string")slot.prices.delete(id);
    for(const price of entry.prices??[]){
      if(typeof price.id==="string"&&typeof price.name==="string"&&
        Number.isSafeInteger(price.priceCents))slot.prices.set(price.id,price);
    }
    slot.priceUpdates.push(...(entry.priceUpdates??[]).filter(p=>
      typeof p.id==="string"&&Number.isSafeInteger(p.priceCents)));
    const times=(entry.times??[]).slice(0,60).filter(t=>
      t&&typeof t.time==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(t.time)&&
      typeof t.day==="string"&&typeof t.role==="string"&&typeof t.complete==="boolean");
    if(entry.timeScope?.kind==="hours"){
      const updated=new Set(entry.timeScope.days);
      slot.times=slot.times.filter(t=>!(["open","close"].includes(t.role)&&updated.has(t.day)));
      slot.times.push(...times);
    }else if(entry.timeScope?.kind==="schedule"){
      const {from,to}=entry.timeScope;
      const exhaustive=entry.timeScope.exhaustive!==false;
      if(from<=to){
        const retained:VerifiedTime[]=[];
        for(const t of slot.times){
          if(!["shiftStart","shiftEnd"].includes(t.role)){
            retained.push(t);continue;
          }
          // A truncated read can only replace an employee/day/role it actually
          // saw. Absence from a truncated list is not evidence of deletion.
          const scopes=exhaustive?[{from,to}]:times.filter(incoming=>
            incoming.day===t.day&&incoming.person===t.person&&incoming.role===t.role)
            .map(incoming=>({from:incoming.validFrom??from,to:incoming.validTo??to}));
          let segments=[t];
          for(const scope of scopes){
            const cutStart=scope.from>from?scope.from:from;
            const cutEnd=scope.to<to?scope.to:to;
            if(cutStart>cutEnd)continue;
            const next:VerifiedTime[]=[];
            for(const segment of segments){
              if((segment.validTo??"9999-12-31")<cutStart||
                 (segment.validFrom??"0000-01-01")>cutEnd){next.push(segment);continue;}
              if((segment.validFrom??"0000-01-01")<cutStart)
                next.push({...segment,validTo:offsetDate(cutStart,-1)});
              if((segment.validTo??"9999-12-31")>cutEnd)
                next.push({...segment,validFrom:offsetDate(cutEnd,1)});
            }
            segments=next;
          }
          retained.push(...segments);
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
    prices:[...slot.prices.values()],priceUpdates:slot.priceUpdates
  })).filter(e=>e.values.length>0||e.times.length>0||e.prices.length>0||
    (e.priceUpdates?.length??0)>0);
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
const monthDayRange=new RegExp(
  months+"\\s+[٠-٩۰-۹\\d]{1,2}\\s*[-–—]\\s*[٠-٩۰-۹\\d]{1,2}|"+
  "[٠-٩۰-۹\\d]{1,2}\\s*[-–—]\\s*[٠-٩۰-۹\\d]{1,2}\\s*(?:de\\s+)?"+months,"giu");

function isCalendarNumber(text: string, start: number, end: number, value: number, kind: Kind): boolean {
  if (kind !== "number" || !Number.isInteger(value)) return false;
  // Month/day ranges are calendar references, including the second
  // endpoint in "Oct 1-22" and signed tokens such as "-22".
  if([...text.matchAll(monthDayRange)].some(m=>
    start<m.index+m[0].length&&end>m.index))return true;
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
function candidates(text:string,locale:AgentLocale):Array<UnverifiedNumber & {value:number;wholePercent:boolean}>{
 return tokenizeNumbers(text,locale).filter(t=>["money","percent","count","decimal","range"].includes(t.kind)&&t.value!==null)
  .filter(t=>!isCalendarNumber(text,t.start,t.end,t.value!,"number"))
  .map(t=>({start:t.start,end:t.end,text:text.slice(t.start,t.end),
    value:t.value!,kind:t.kind==="money"?"money":t.kind==="percent"?"percent":"number",
    wholePercent:t.kind==="percent"&&!/[.,٫٬]/u.test(text.slice(t.start,t.end))}));
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
  const amountFirstEstimate=/^\s*(?:(?:is|are|was|were|equals?|represents?)\s+(?:(?:your|the|our|estimated|daily)\s+)?|(?:es|son|equivale a)\s+(?:(?:tu|tus|el|la|los|las)\s+)?|(?:هو|هي|يمثل|تمثل)\s+)?(?:break[ -]?even|breakeven|shortfall|overhead|fixed costs?|daily costs?|sales gap|punto de equilibrio|ventas de equilibrio|gastos? fijos?|costos? fijos?|نقطة التعادل|التعادل|التكاليف الثابتة|المصاريف الثابتة)/iu;
  return moneyWords.test(before) ||
    /^\s*(?:in\s+)?(?:profit|revenue|sales|costs?|expenses?|income|cash|rent|wages?|payroll|ganancia|beneficio|ingresos)\b/iu.test(after)||
    amountFirstEstimate.test(after);
}

/** Known configured hours remain evidence for their own weekday even when
 * other weekdays are missing. An unknown weekday is never silently closed. */
/** A second product's numeric price cannot establish a named item's price. */
function directItemPriceClaim(text:string,start:number,end:number,prices:readonly MenuPrice[]):number|null {
  const before=text.slice(0,start);
  const sentenceStart=Math.max(before.lastIndexOf("."),before.lastIndexOf("!"),
    before.lastIndexOf("?"),before.lastIndexOf("\n"))+1;
  const phrase=before.slice(sentenceStart).trim().toLocaleLowerCase();
  const after=text.slice(end);
  if(/^\s*(?:more|less|cheaper|pricier)\s+than\b/iu.test(after))return null;
  const matches=prices.filter(p=>{
    const name=p.name.trim().toLocaleLowerCase();
    if(!name)return false;
    const at=phrase.lastIndexOf(name);
    if(at<0)return false;
    const previous=phrase[at-1]??" ";
    if(/[\p{L}\p{M}\p{N}]/u.test(previous))return false;
    const suffix=phrase.slice(at+name.length).trim();
    return /^(?:is|costs?|priced\s+at|sells?\s+for|price\s+is)$/iu.test(suffix);
  });
  // "Iced Latte" contains "Latte": the longer complete product name
  // wins; only genuinely ambiguous equal-length identities fail closed.
  matches.sort((a,b)=>b.name.trim().length-a.name.trim().length);
  if(matches.length===0)return null;
  if(matches.length>1&&matches[1].name.trim().length===matches[0].name.trim().length)
    return -1;
  return matches[0].priceCents;
}

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
  }).filter(x=>x.at>=0).sort((a,b)=>
    (b.at+b.price.name.length)-(a.at+a.price.name.length)||
    b.price.name.length-a.price.name.length);
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
// The clock token includes the meridiem: dropping Arabic "مساءً" silently
// turns a 5 PM closing claim into the wrong 05:00 morning assertion.
function clockSpansFromTokens(text:string,locale:AgentLocale="en"):ClockSpan[]{
 return tokenizeNumbers(text,locale).filter(t=>t.kind==="clock"||t.kind==="clockRange")
  .map(t=>Object.assign([text.slice(t.start,t.end)] as unknown as RegExpMatchArray,{index:t.start}));
}
function canonicalClock(clock:ClockSpan):string|null {
  const raw=ascii(clock[0]).replace(/a\\.m\\./giu,"AM").replace(/p\\.m\\./giu,"PM");
  const matched=raw.match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(AM|PM|صباح[\u064b-\u065f]*|مساء[\u064b-\u065f]*)|h(\d{2})?)?$/iu);
  if(!matched)return null;
  let hour=Number(matched[1]);
  if(matched[3]){
    const evening=/^(?:PM|م|مساء)/iu.test(matched[3]);
    hour=(hour%12)+(evening?12:0);
  }
  if(hour>23||Number(matched[2]??matched[4]??"00")>59)return null;
  return String(hour).padStart(2,"0")+":"+(matched[2]??matched[4]??"00");
}

/** Mask meridiem abbreviations without shifting source offsets. */
function sentenceBoundary(prefix:string):number{
 const masked=prefix.replace(/(?:a\\.m\\.|p\\.m\\.)/giu,"    ");
 return Math.max(masked.lastIndexOf("\\n"),masked.lastIndexOf("."),
  masked.lastIndexOf("!"),masked.lastIndexOf("?"),masked.lastIndexOf(";"))+1;
}
function timeRole(text:string, clock:ClockSpan):TimeRole|null {
  const prefix=text.slice(0,clock.index);
  const sentenceStart=sentenceBoundary(prefix);
  const phrase=text.slice(sentenceStart,clock.index);
  // In an opening-hours range the second endpoint is closing time, even
  // though "open" remains the closest action verb: "open from 8 to 5".
  const precedingClocks=clockSpansFromTokens(phrase);
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
  const sentenceStart=sentenceBoundary(prefix);
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
  if(selected.length>0)return [...new Set(selected.map(m=>m.day))];
  // A single trailing weekday can govern *both* endpoints of a genuine
  // "open from 8:00 to 17:00 on Tuesday" interval.
  if(next&&((timeRole(text,clock)==="open"&&timeRole(text,next)==="close")||
    (timeRole(text,clock)==="shiftStart"&&timeRole(text,next)==="shiftEnd"))){
    const tail=mentions(text.slice(clockEnd(next),sentenceEnd),clockEnd(next));
    return [...new Set(tail.map(m=>m.day))];
  }
  return [];

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
  // Localized constructions must retain the employee identity. Never
  // degrade "El turno de Bob..." to an anonymous shift backed by Ada.
  const spanish=[...before.matchAll(/\b(?:turno|jornada)\s+(?:de|del)\s+([\p{L}\p{M}]+)/giu)].at(-1);
  if(spanish)return {kind:"named",name:normalizedEmployeeName(spanish[1])};
  const arabic=[...before.matchAll(/(?:وردية|مناوبة)\s+(?:لـ?\s*)?([\p{L}\p{M}]+)/gu)].at(-1);
  if(arabic)return {kind:"named",name:normalizedEmployeeName(arabic[1])};
  if(/\b(?:turno|jornada)\s+(?:de|del)\s+\S+|(?:وردية|مناوبة)\s+\S+/iu.test(before))
    return {kind:"unresolved"};
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
  const months=new RegExp("(?<![\\p{L}\\p{M}])("+MONTH_LABEL+")(?![\\p{L}\\p{M}])","iu");
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

function canonicalPricesExistInRead(previous:readonly NumericEvidence[],
  current:readonly AgentToolResult[]):boolean {
  return previous.some(e=>(e.prices?.length??0)>0)||
    current.some(r=>{
      const items=r.source==="menu_items"&&Array.isArray(r.items)?r.items:
        r.source==="product_costs"?[r.item]:[];
      return items.some(item=>item&&typeof item==="object"&&
        typeof item.id==="string"&&typeof item.name==="string"&&
        typeof item.priceCents==="number");
    });
}

/** Date-qualified financial claims may only cite that date's observed metric.
 * Period aggregates are not evidence about an arbitrary day within the range. */
function datedFinancialScope(text:string,start:number,end:number):{date:string|null;metric:string}|null {
  const before=text.slice(0,start);
  const from=Math.max(before.lastIndexOf("\n"),before.lastIndexOf("!"),
    before.lastIndexOf("?"),before.lastIndexOf(";"))+1;
  const after=text.slice(end);
  const stop=after.search(/[!?;\n]/u);
  const clause=text.slice(from,stop<0?text.length:end+stop);
  const metric=/\b(?:sales|revenue|sold|drinks sold)\b/iu.test(clause)?"sales":
    /\b(?:staff tax|wages|labor|payroll)\b/iu.test(clause)?"labor":
    /\b(?:expenses?|spending)\b/iu.test(clause)?"expenses":
    /\b(?:profit|margin)\b/iu.test(clause)?"profit":null;
  if(!metric)return null;
  const date=parseCalendarReference(clause);
  if(date===undefined)return null;
  return {date,metric};
}
function evidenceSupportsDatedMoney(evidence:readonly NumericEvidence[],
  date:string,cents:number,metric:string):boolean {
  return evidence.some(entry=>{
    // Initiative observations carry their *validated* metric identity
    // alongside the date. Money from item margin or per-hour sales cannot
    // prove TOTAL daily sales just because the cent amounts happen to match.
    if(entry.tool==="owner_initiatives"){
      const allowedKey=metric==="sales"?"net_sales":
        metric==="labor"?"labor_cost":metric==="profit"?"net_profit":null;
      return allowedKey!==null&&entry.values.some(v=>
        v.unit==="cents"&&Math.abs(v.value-cents)<=1&&
        v.key.includes("/key:"+allowedKey+"/day:"+date+"/")&&
        v.key.endsWith("/observationCents"));
    }
    const correctSource=metric==="sales"?entry.tool==="daily_rollups"||entry.tool==="item_sales":
      metric==="labor"?entry.tool==="labor_and_attendance":
      metric==="expenses"?entry.tool==="expenses":entry.tool==="profitability";
    if(!correctSource)return false;
    return entry.values.some(v=>{
      if(v.unit!=="cents"||Math.abs(v.value-cents)>1)return false;
      const key=v.key;
      const dated=key.startsWith(date+"/"+date+"/")||key.includes("day:"+date+"/");
      if(!dated)return false;
      return metric==="sales"?/netSalesCents$|grossSalesCents$/u.test(key):
        metric==="labor"?/Cents$/u.test(key):
        metric==="expenses"?/recordedActualTotalCents$/u.test(key):
        /ownerProfitCents$/u.test(key);
    });
  });
}


// Owner-spoken numbers are parsed as complete, bounded expressions. A monetary
// sign, major unit, cents, and quantity unit may not be separated or borrowed
// from another sentence. Unsupported/ambiguous expressions fail closed.
const WORD_NUMBERS:Record<AgentLocale,Record<string,number>>={
  en:{zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90},
  es:{cero:0,uno:1,una:1,un:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,dieciseis:16,dieciséis:16,diecisiete:17,dieciocho:18,diecinueve:19,veinte:20,veintiuno:21,veintidós:22,veintidos:22,veintitrés:23,veintitres:23,veinticuatro:24,veinticinco:25,veintiséis:26,veintiseis:26,veintisiete:27,veintiocho:28,veintinueve:29,treinta:30,cuarenta:40,cincuenta:50,sesenta:60,setenta:70,ochenta:80,noventa:90},
  ar:{"صفر":0,"واحد":1,"واحدة":1,"اثنين":2,"اثنان":2,"اثنتان":2,"اثنتين":2,"ثلاثة":3,"ثلاث":3,"أربعة":4,"اربعة":4,"خمسة":5,"ستة":6,"سبعة":7,"ثمانية":8,"ثمان":8,"تسعة":9,"عشرة":10,"عشر":10,"عشرون":20,"ثلاثون":30,"أربعون":40,"اربعون":40,"خمسون":50,"ستون":60,"سبعون":70,"ثمانون":80,"تسعون":90}
};
type SpokenWord={word:string;start:number;end:number;group:number};
type SpokenValue={value:number;kind:Kind};
function ownerWordTokens(text:string,locale:AgentLocale):SpokenWord[]{
  const words:SpokenWord[]=[];
  let group=0,lastEnd=0;
  for(const match of text.matchAll(/[\p{L}\p{M}]+/gu)){
    // Only whitespace or hyphens can join one number expression.
    if(/[^\s-]/u.test(text.slice(lastEnd,match.index)))group++;
    lastEnd=match.index+match[0].length;
    const word=match[0].replace(/[\u064b-\u065f]/gu,"").toLocaleLowerCase();
    if(locale==="ar"&&word.startsWith("و")&&
      !Object.hasOwn(WORD_NUMBERS.ar,word)&&
      Object.hasOwn(WORD_NUMBERS.ar,word.slice(1))){
      words.push({word:"و",start:match.index,end:match.index+1,group});
      words.push({word:word.slice(1),start:match.index+1,end:match.index+match[0].length,group});
    }else words.push({word,start:match.index,end:match.index+match[0].length,group});
  }
  return words;
}
function spokenOwnerValues(text:string,locale:AgentLocale):SpokenValue[]{
  const words=ownerWordTokens(text,locale),dict=WORD_NUMBERS[locale];
  const signs=locale==="en"?["minus","negative"]:locale==="es"?["menos","negativo","negativa"]:["سالب","ناقص"];
  const joiners=locale==="en"?["and"]:locale==="es"?["y"]:["و"];
  const decimalWords=locale==="en"?["point"]:locale==="es"?["coma","punto","con"]:["فاصلة","فاصل"];
  const dollars=locale==="en"?["dollar","dollars","buck","bucks"]:
    locale==="es"?["dólar","dólares","dolar","dolares","euro","euros"]:["دولار","دولارات","ريال","ريالات","درهم","دراهم"];
  const centsUnits=locale==="en"?["cent","cents"]:
    locale==="es"?["centavo","centavos","céntimo","céntimos"]:["سنت","سنتا","سنتات"];
  const percents=locale==="en"?["percent"]:locale==="es"?["porciento"]:["بالمئة","بالمائة"];
  const unsupported=locale==="en"?["hundred","thousand","million"]:
    locale==="es"?["cien","ciento","cientos","mil","millón","millon"]:["مئة","مائة","ألف","الف"];
  const monetaryContext=/\b(?:price|cost|costs|dollars?|cents?|rent|profit|loss|salary|wages?|fee|bill|latte|mocha|espresso|precio|cuesta|costo|coste|dólares?|centavos?|alquiler|ganancia)\b|(?:سعر|ثمن|تكلفة|دولار|سنت|ربح|خسارة)/iu;
  const quantities=/^(?:drinks?|orders?|people|employees?|staff|cups?|days?|weeks?|coffees?|customers?|lattes?|mochas?|items?|units?|servings?|tickets?|shifts?|workers?|bebidas?|personas?|días?|semanas?|artículos?|clientes?|موظفين|أشخاص|اشخاص|أيام|ايام|أسابيع|أكواب|مشروبات|طلبات)(?!\p{L})/iu;
  const result:SpokenValue[]=[];
  const is=(i:number,list:readonly string[],group?:number)=>i<words.length&&
    (group===undefined||words[i].group===group)&&list.includes(words[i].word);
  const number=(at:number):{value:number;next:number}|null=>{
    const major=words[at]&&dict[words[at].word];
    if(major===undefined)return null;
    let next=at+1,value=major;
    const connector=is(next,joiners,words[at].group)?1:0;
    const minor=words[next+connector]?.group===words[at].group?
      dict[words[next+connector].word]:undefined;
    if(major>=20&&major%10===0&&minor!==undefined&&minor>0&&minor<10){
      value+=minor;next+=connector+1;
    }else if(locale==="ar"&&major>0&&major<10&&connector===1&&
      minor!==undefined&&minor>=20&&minor%10===0){
      // In Arabic, "خمسة وخمسون" is 55, with the units first.
      value+=minor;next+=2;
    }else if(locale==="ar"&&major>0&&major<10&&connector===0&&minor===10){
      // A teen ("خمسة عشر") is one number, not the price five.
      value+=10;next++;
    }
    return {value,next};
  };
  for(let i=0;i<words.length;){
    const initial=i,negative=is(i,signs);
    if(negative)i++;
    if(negative&&words[i]?.group!==words[initial].group){i=initial+1;continue;}
    const whole=number(i);
    if(!whole){i=initial+1;continue;}
    let next=whole.next,value=whole.value*100;
    const currentGroup=words[i].group;
    let attachedMoney=false,attachedPercent=false;
    if(is(next,decimalWords,currentGroup)){
      const fractional=words[next+1]?.group===currentGroup?number(next+1):null;
      if(!fractional){i=next+1;continue;}
      next=fractional.next;
      // A spoken decimal can contain either a whole two-digit fractional
      // number ("point fifty") or two individual digits ("point two five").
      // Consume both digits as ONE amount, never publish "$8.20" early.
      const digitAfter=words[next]?.group===currentGroup?number(next):null;
      if(fractional.value<10&&digitAfter&&digitAfter.value<10){
        value+=fractional.value*10+digitAfter.value;
        next=digitAfter.next;
      }else{
        value+=fractional.value<10?fractional.value*10:fractional.value;
      }
    } else if(is(next,dollars,currentGroup)){
      attachedMoney=true;next++;
      const conjunct=is(next,joiners,currentGroup)?1:0;
      const fractional=words[next+conjunct]?.group===currentGroup?number(next+conjunct):null;
      if(fractional&&fractional.value<=99&&
        !is(fractional.next,dollars,currentGroup)){
        // "five dollars and ten dollars" states two whole prices.
        // A second currency unit cannot be a fractional-cent component.
        next=fractional.next;
        const explicitCents=is(next,centsUnits,currentGroup);
        value+=explicitCents?fractional.value:
          fractional.value<10?fractional.value*10:fractional.value;
        if(explicitCents)next++;
      }
    } else if(is(next,centsUnits,currentGroup)){
      attachedMoney=true;value=whole.value;next++;
    } else {
      const colloquial=words[next]?.group===currentGroup?number(next):null;
      if(colloquial&&whole.value<=19&&colloquial.value>=10&&colloquial.value<=99){
        value+=colloquial.value;next=colloquial.next;
        attachedMoney=true;
      }
    }
    if(is(next,dollars,currentGroup)){attachedMoney=true;next++;}
    if(is(next,percents,currentGroup)){attachedPercent=true;next++;}
    else if(locale==="es"&&is(next,["por"],currentGroup)&&is(next+1,["ciento"],currentGroup)){
      attachedPercent=true;next+=2;
    }
    if(is(next,centsUnits,currentGroup)&&!attachedMoney){attachedMoney=true;value=Math.round(value/100);next++;}
    const prefix=text.slice(Math.max(0,words[initial].start-100),words[initial].start);
    const before=prefix.split(/[.!?;\n]/u).pop()??"";
    const after=text.slice(words[next-1].end).split(/[.!?;\n]/u)[0]??"";
    const explicitQuantity=quantities.test(after.trimStart());
    // A larger unsupported numeral contaminates its entire clause: never
    // reinterpret just the trailing "fifty" in "one hundred and fifty".
    const clause=[before,after].join(" ").toLocaleLowerCase();
    const unsupportedAdjacent=unsupported.some(word=>new RegExp("(?<!\\p{L})"+word+"(?!\\p{L})","iu").test(clause));
    if(unsupportedAdjacent||(explicitQuantity&&attachedMoney)){i=next;continue;}
    const money=!explicitQuantity&&(attachedMoney||monetaryContext.test(before)||monetaryContext.test(after.slice(0,30)));
    const signed=negative?-1:1;
    result.push({value:signed*(attachedPercent?value:money?value:value/100),
      kind:attachedPercent?"percent":money?"money":"number"});
    i=next;
  }
  return result;
}
function proposedDuration(text:string,start:number,end:number):boolean{
 const before=text.slice(Math.max(0,start-55),start),after=text.slice(end,end+25);
 return /^\s*(?:days?|weeks?|días?|semanas?|أيام|ايام|أسابيع|اسابيع)(?!\p{L})/iu.test(after)&&
  /(?:\b(?:for|over|por|durante)\b|(?:لمدة|خلال))\s*$/iu.test(before)&&
  /(?:\b(?:try|test|plan|propose|recommend|suggest|run a trial|prueba|probar|propongo|recomiendo|sugiero)\b|(?:نجرب|اقترح|جرب|جرّب|أوصي))/iu.test(before);
}
type MathOp="add"|"subtract";
/** A join belongs to an arithmetic expression, not arbitrary neighboring
 * money mentions ("Budget $10, prices are $6 and $5.50"). */
function arithmeticConnector(text:string):MathOp|null {
  if(/^\s*,\s*$/u.test(text))return "add";
  if(/^\s*(?:\+|and|plus|y|más|زائد|و)\s*$/iu.test(text))return "add";
  if(/^\s*(?:-|minus|less|menos|ناقص)\s*$/iu.test(text))return "subtract";
  // Labels are allowed around a comparison, but only an explicit operator
  // permits it. This is the owner-price vs menu-price form.
  if(text.length<=65&&/\b(?:vs\.?|versus)\b/iu.test(text))return "subtract";
  return null;
}
/** numberPattern consumes a sign before currency as part of its token.
 * In an expression between two amounts, that leading sign is the operator. */
function symbolicMoneyOperator(token:string):MathOp|null {
  const sign=token.trimStart().match(/^([+\-−])\s*(?=[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار|ريال|درهم)/iu)?.[1];
  return sign==="+"?"add":sign==="-"||sign==="−"?"subtract":null;
}
function explicitLocalArithmetic(text:string,v:{start:number;end:number;kind:Kind;value:number},
 locale:AgentLocale,allowed:ReadonlySet<number>):boolean|null {
  const money=candidates(text,locale).filter(c=>c.kind==="money"||
    (c.kind==="number"&&isCurrencylessMoneyClaim(text,c.start,c.end)));
  const index=money.findIndex(c=>c.start===v.start&&c.end===v.end);
  if(index<2)return null;
  const prefix=text.slice(0,v.start);
  // Sentence boundaries apply in every supported locale, not just EN.
  const sentenceStops=[...prefix.matchAll(/\.(?![\d٠-٩۰-۹])/gu)].map(m=>m.index);
  const boundary=Math.max(prefix.lastIndexOf("\n"),prefix.lastIndexOf(";"),
    prefix.lastIndexOf("!"),prefix.lastIndexOf("?"),...sentenceStops);
  const prior=money.slice(0,index).filter(c=>c.start>boundary);
  if(prior.length<2)return null;
  // Require the marker immediately before the proposed result. An earlier
  // "total" cannot mark a later, independently reported tip as arithmetic.
  const immediate=text.slice(prior[prior.length-1].end,v.start);
  const resultMarker=/\b(?:together|altogether|combined|total|sum|in all|en total|juntos|suma|difference|diferencia)\b|(?:المجموع|الإجمالي|الفرق|معا|معًا)|=/iu;
  if(!resultMarker.test(immediate))return null;
  // A KPI is valid only when backed by a tool or an owner statement, never
  // by generic arithmetic of other business observations.
  const kpi=/\b(?:profit|revenue|sales|wages|payroll|staff costs|expenses|operating margin|beneficio|ganancia|ingresos|ventas|gastos|costes|costos|salarios)\b|(?:الربح|ربح|المبيعات|الإيرادات|التكاليف|المصاريف)/iu;
  if(kpi.test(immediate))return null;
  const operands=[prior[prior.length-1]];
  const operators:MathOp[]=[];
  for(let pos=prior.length-2;pos>=0;pos--){
    const following=operands[0];
    const between=text.slice(prior[pos].end,following.start);
    const join=arithmeticConnector(between)||
      (between.trim()===""?symbolicMoneyOperator(following.text):null);
    if(!join)break; // unrelated preceding money belongs to another claim
    operands.unshift(prior[pos]);
    operators.unshift(join);
    if(operands.length>3)return false; // only 2-3 operands supported
  }
  if(operands.length<2)return null;
  const toCents=(c:{kind:Kind;value:number})=>
    c.kind==="money"?c.value:Math.round(c.value*100);
  const cents=operands.map((operand,i)=>{
    const raw=toCents(operand);
    // An operator incorporated into a following money token is not the
    // amount's sign: "$6 -$5.50" must read 600 - 550, not 600 - (-550).
    return i>0&&symbolicMoneyOperator(operand.text) ? Math.abs(raw) : raw;
  });
  if(!cents.every(amount=>[...allowed].some(a=>Math.abs(a-amount)<=1)))return false;
  // A sum of two unrelated business KPIs is not tool-backed merely because
  // its operands are individually observed.
  const expression=text.slice(operands[0].start,v.start);
  if(kpi.test(expression))return null;
  const signed=cents.map((amount,i)=>i===0||operators[i-1]==="add"?amount:-amount);
  const expected=sumCents(signed,amount=>amount);
  return Math.abs(expected-toCents(v))<=1;
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
    for(const v of entry.values){
      if(!Number.isFinite(v.value))continue;
      // Item-scoped prices are replaced by the canonical product ID map.
      // Legacy unscoped price values cannot outrank named current products.
      if(v.unit==="cents"&&
        !(v.key.endsWith("priceCents")&&
          (v.key.includes("item:")||canonicalPricesExistInRead(previousEvidence,results))))
        allowed.money.add(v.value);
      if(v.unit==="bps")allowed.percent.add(v.value);
      if(v.unit==="ratio")allowed.percent.add(Math.round(v.value*10000));
      if(v.unit==="count"&&trustedCountKey(v.key))allowed.number.add(v.value);
    }
  }
  // A menu price describes a product ID, not the tool that happened to read
  // it. Reconcile chronologically across menu_items and product_costs before
  // comparing named prices or authorizing money amounts.
  const canonicalPrices=new Map<string,MenuPrice>();
  const chronological=[...previousEvidence,...compactEvidence(results,Infinity)];
  for(const entry of chronological){
    for(const id of entry.invalidatedPriceIds??[])canonicalPrices.delete(id);
    for(const price of entry.prices??[])
      if(typeof price.id==="string"&&typeof price.name==="string"&&
        Number.isSafeInteger(price.priceCents))canonicalPrices.set(price.id,price);
    for(const update of entry.priceUpdates??[]){
      const previous=canonicalPrices.get(update.id);
      if(previous&&Number.isSafeInteger(update.priceCents))
        canonicalPrices.set(update.id,{...previous,priceCents:update.priceCents});
    }
  }
  const itemPrices=[...canonicalPrices.values()];
  // Unnamed money statements may refer to a current menu price, but never
  // to an old price superseded by another tool's fresh product observation.
  for(const item of itemPrices)allowed.money.add(item.priceCents);
  const menuPrices=itemPrices;
  const ownerNumbers=candidates(ownerText,locale);
  ownerNumbers.forEach(v=>allowed[v.kind].add(v.value));
  for(const spoken of spokenOwnerValues(ownerText,locale))allowed[spoken.kind].add(spoken.value);
  // Only reconciled, typed numeric evidence authorizes an amount.
  // Re-adding raw current-turn estimates here would resurrect a prior result
  // that a later tool result explicitly invalidated in this same turn.
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
  const clocks=clockSpansFromTokens(text,locale);
  const ownerClocks=clockSpansFromTokens(ownerText,locale);
  // Keep semantic business-time grounding even though provenance dots are
  // exempted from clock display. Each endpoint is a single shared token.
  const unsupportedClocks=clocks.filter(clock=>{
      const role=timeRole(text,clock);
      if(!role){
        // Sales prose may include incidental timestamps (e.g. "999 (8:00)");
        // do not mistake the clock for the adjacent sale count. But any
        // recognizably business-time assertion must fail closed on an
        // unrecognized action, in every supported language.
        const prior=text.slice(0,clock.index);
        const sentenceStart=Math.max(prior.lastIndexOf("\n"),prior.lastIndexOf("."),
          prior.lastIndexOf("!"),prior.lastIndexOf("?"),prior.lastIndexOf(";"))+1;
        const sentenceEnd=text.slice(clockEnd(clock)).search(/[.!?;\n]/u);
        const sentence=text.slice(sentenceStart,sentenceEnd<0?text.length:clockEnd(clock)+sentenceEnd);
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
  }).map(clock=>({text:clock[0],start:clock.index,end:clockEnd(clock),kind:"number" as const}));
  const rejectedQuantities=candidates(text, locale).filter(v => {
    if(v.kind==="number" && isListMarker(text,v.start,v.end,v.value))return false;
    if(v.kind==="number"&&proposedDuration(text,v.start,v.end))return false;
    // Named price and comparison claims are identity-sensitive. Validate
    // them BEFORE checking whether some unrelated raw amount happens to match.
    const moneyLike=v.kind==="money"||
      (v.kind==="number"&&isCurrencylessMoneyClaim(text,v.start,v.end));
    if(moneyLike){
      const cents=v.kind==="money"?v.value:Math.round(v.value*100);
      const dated=datedFinancialScope(text,v.start,v.end);
      if(dated){
        if(!dated.date)return true;
        const observedForDate=evidenceSupportsDatedMoney(evidence,dated.date,cents,dated.metric);
        const ownerBacked=ownerNumbers.some(owner=>(owner.kind==="money"?owner.value:
          owner.kind==="number"?Math.round(owner.value*100):NaN)===cents&&
          datedFinancialScope(ownerText,owner.start,owner.end)?.date===dated.date);
        return !(observedForDate||ownerBacked);
      }
      const comparison=/^\s*(?:more than|less than|cheaper than|pricier than)\b/iu.test(text.slice(v.end));
      if(comparison)return !verifiedMenuDifference(text,v.start,v.end,cents,menuPrices);
      const itemPrice=directItemPriceClaim(text,v.start,v.end,itemPrices);
      if(itemPrice!==null)return Math.abs(itemPrice-cents)>1;
    }
    // An explicit arithmetic claim is checked before raw value membership:
    // an unrelated observed $12 must never validate 5.50 + 6.00 = $12.
    if(moneyLike){
      const derived=explicitLocalArithmetic(text,v,locale,allowed.money);
      if(derived!==null)return !derived;
    }
    // A signed currency operand in an explicit symbolic expression is an
    // operation on an observed positive amount, not a new negative KPI.
    if(v.kind==="money"&&symbolicMoneyOperator(v.text)&&v.value<0){
      const earlier=candidates(text,locale).filter(c=>c.kind==="money"&&c.end<=v.start).at(-1);
      if(earlier&&text.slice(earlier.end,v.start).trim()===""&&
        [...allowed.money].some(a=>Math.abs(a-Math.abs(v.value))<=1))return false;
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
  return [...rejectedQuantities,...unsupportedClocks].sort((a,b)=>a.start-b.start);
}

/** The numeric value is not the metric identity. Only attach an estimate
 * explanation when its clause explicitly identifies that business metric.
 * Return null for named items or ambiguous prose, never invent attribution. */
function estimateClaimMetric(text:string,start:number,end:number):"breakEvenSales"|"salesGap"|"dailyOverhead"|null {
  const before=text.slice(Math.max(0,start-160),start);
  const prior=before.split(/(?:[!?;,]\s*|\.(?!\d)\s+|\n)/u).at(-1)??"";
  const after=text.slice(end,end+120).split(/(?:[!?;,\n]|\.(?!\d))/u)[0]??"";
  const metrics=[
    {detail:"dailyOverhead",pattern:/\b(?:overhead|fixed[ -]costs?|daily[ -]costs?|operating costs?)\b|(?:costos? fijos?|gastos? fijos?|costes? fijos?|مصروفات ثابتة|تكاليف ثابتة|التكاليف الثابتة|المصاريف الثابتة)/giu},
    {detail:"salesGap",pattern:/\b(?:shortfall|deficit|sales gap|gap|difference from|below target)\b|(?:brecha|déficit|diferencia|faltante|الفجوة|العجز|الفرق)/giu},
    {detail:"breakEvenSales",pattern:/\b(?:break[ -]?even|breakeven)\b|(?:punto de equilibrio|ventas de equilibrio|نقطة التعادل|التعادل)/giu},
  ] as const;
  // Choose the closest named metric, not the first kind mentioned in the
  // clause. Two independent amounts can be joined by "and" without a comma.
  const nearest=(clause:string,side:"before"|"after")=>{
    let best:{detail:(typeof metrics)[number]["detail"];distance:number}|null=null;
    for(const metric of metrics){
      for(const match of clause.matchAll(metric.pattern)){
        const distance=side==="before"
          ?clause.length-(match.index+match[0].length):match.index;
        if(!best||distance<best.distance)best={detail:metric.detail,distance};
      }
    }
    return best?.detail??null;
  };
  // For amount-first claims ("$129.88 is your break-even"), the immediately
  // following predicate is stronger evidence than a preceding unrelated KPI.
  const amountFirst=/^\s*(?:(?:is|are|was|were|equals?|represents?|means?)\b|(?:es|son|equivale a)\b|(?:هو|هي|يمثل|تمثل))\s+/iu.test(after);
  return (amountFirst?nearest(after,"after"):null)??nearest(prior,"before");
}

export type NumberProvenance = UnverifiedNumber & {source:"owner"|"estimate"|"unchecked";detail?:string};
/** Original UTF-16 offsets; existing checker remains the sole authority for unsupported claims. */
export function numberProvenance(text:string,ownerText:string,results:readonly AgentToolResult[],
  locale:AgentLocale,previousEvidence:readonly NumericEvidence[]=[],
  verifiedVerdict?:readonly UnverifiedNumber[]):NumberProvenance[]{
 const supplied=candidates(ownerText,locale),spoken=spokenOwnerValues(ownerText,locale);
 // Saved numeric observations carry estimate origin and detail through turns.
 // Reconcile first so stale amounts cannot inherit labels after fresh reads.
 const estimates=reconcileSavedEvidence([...previousEvidence,...compactEvidence(results,Infinity)])
  .flatMap(entry=>entry.values)
  .filter((v):v is typeof v & {provenance:"estimate";detail:"breakEvenSales"|"salesGap"|"dailyOverhead"}=>
    v.provenance==="estimate"&&
    (v.detail==="breakEvenSales"||v.detail==="salesGap"||v.detail==="dailyOverhead"));

 // The numeric verifier owns EVERY reject/allow decision. Projection below
 // may decorate supported facts, but it may not suppress unsupported claims.
 const rejected=verifiedVerdict??checkNumbers(text,ownerText,results,locale,previousEvidence);
 const rejectedBySpan=new Map(rejected.map(v=>[v.start+":"+v.end,v]));
 const clocks=clockSpansFromTokens(text,locale);
 const evidence=reconcileSavedEvidence([...previousEvidence,...compactEvidence(results,Infinity)]);
 const menuPrices=evidence.flatMap(entry=>entry.prices??[]);
 const annotated:NumberProvenance[]=[];
 const withUnit=(v:{text:string;start:number;end:number;kind:Kind})=>{
   // Treat number + day unit as a single footnote phrase. Validate on the
   // ORIGINAL numeric span before extending the display span.
   if(v.kind!=="number")return v;
   const tail=/^([ \t\u00a0\u202f]*(?:days?|días?|أيام|ايام|weeks?|semanas?|أسابيع|اسابيع))(?!\p{L})/iu.exec(text.slice(v.end));
   const end=tail?v.end+tail[1].length:v.end;
   return {...v,end,text:text.slice(v.start,end)};
 };
 for(const v of candidates(text,locale)){
   const key=v.start+":"+v.end;
   const unsupportedClaim=rejectedBySpan.has(key);
   if(unsupportedClaim){
     // Protect rejected day counts, business hours, and item/date mismatches
     // BEFORE the UI's optional cosmetic exemptions.
     annotated.push({...withUnit(v),source:"unchecked"});
     continue;
   }
   if(clocks.some(m=>v.start<m.index+m[0].length&&v.end>m.index))continue;
   if(v.kind==="number"&&(isListMarker(text,v.start,v.end,v.value)||proposedDuration(text,v.start,v.end)||
      /^\s*(?:days?|días?|أيام|ايام)\b/iu.test(text.slice(v.end))))continue;
   const moneyLike=v.kind==="money"||
     (v.kind==="number"&&isCurrencylessMoneyClaim(text,v.start,v.end));
   // A named product price is a recorded fact, even if an unrelated model
   // estimate has the same amount. Use the checker's identity-aware matcher.
   if(moneyLike&&directItemPriceClaim(text,v.start,v.end,menuPrices)!==null)
     continue;
   const metric=moneyLike?estimateClaimMetric(text,v.start,v.end):null;
   const cents=v.kind==="money"?v.value:Math.round(v.value*100);
   const e=metric&&!datedFinancialScope(text,v.start,v.end)
     ?estimates.find(x=>x.detail===metric&&x.unit==="cents"&&
       Math.abs(x.value-cents)<=1):undefined;
   if(e){annotated.push({...withUnit(v),source:"estimate",detail:e.detail});continue;}
   const owner=supplied.some(x=>x.kind===v.kind&&x.value===v.value)||
      spoken.some(x=>x.kind===v.kind&&x.value===v.value);
   if(owner){annotated.push({...withUnit(v),source:"owner"});}
 }
 // Guard against parser divergence: every rejected span must survive. There
 // must never be fewer unchecked source marks than the checker reported.
 for(const rejectedSpan of rejected){
   if(!annotated.some(a=>a.start===rejectedSpan.start&&a.source==="unchecked"))
     annotated.push({...withUnit(rejectedSpan),source:"unchecked"});
 }
 annotated.sort((a,b)=>a.start-b.start);

 return annotated;
}
