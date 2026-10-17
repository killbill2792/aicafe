import { createHash } from "node:crypto";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import arMessages from "@/messages/ar.json";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { EvidenceReference, SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";

type Locale = "en" | "es" | "ar";
type ReadView = { blocks: SupervisorReplyBlock[]; evidence: EvidenceReference[] };
type Catalog = typeof enMessages.SupervisorP3Reads;
type Heading = keyof Catalog["headings"];
type Field = keyof Catalog["fields"];
type Unit = keyof Catalog["units"];
const catalogs = {
  en:enMessages.SupervisorP3Reads,
  es:esMessages.SupervisorP3Reads,
  ar:arMessages.SupervisorP3Reads,
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Audited canonical source-specific presentation contract. The model cannot
 * add or choose displayed field keys. All owner copy is in EN/ES/AR catalogs.
 * Unregistered or newly shipped domain schemas need an independent contract.
 */
const sources:Record<string,{heading:Heading;fields:readonly Field[]}> = {
  "supplies.quotes":{heading:"supplierQuotes",
    fields:["supplierName","itemName","priceCents","packageCount"]},
  "menu.catalog":{heading:"menuCatalog",fields:["name","priceCents"]},
  "menu.product_economics":{heading:"productCosts",
    fields:["name","priceCents","ingredientsCentsToday"]},
  "menu.ingredients":{heading:"ingredients",fields:["name"]},
  "labor.employee_wages":{heading:"staffWages",
    fields:["name","defaultHourlyWageCents"]},
  "money.monthly_bills":{heading:"monthlyBills",fields:["totalCents"]},
  "money.recurring_bill_rows":{heading:"billRows",
    fields:["label","amountCents"]},
  "money.recorded_spending":{heading:"recordedSpending",fields:["totalCents"]},
  "money.expense_entries":{heading:"expenseEntries",fields:["amountCents"]},
};
const safeText=(value:string):string|null=>{
  const text=value.replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
  return text && text.length<=120 && !/https?:\/\/|www\./iu.test(text)?text:null;
};
function displayedField(id:string,row:Record<string,unknown>,key:Field,
  locale:Locale):string|null{
  const value=row[key],catalog=catalogs[locale];
  // Record-specific status is authoritative for this field. A different
  // missing input never hides a genuinely recorded zero price.
  if(key==="priceCents" && id==="menu.catalog" && row.priceStatus!=="recorded")return null;
  if(key==="ingredientsCentsToday" && row.costStatus!=="READY")return null;
  if(key==="defaultHourlyWageCents" &&
    (row.wageKnown!==true || row.wagePeriod!=="hour"))return null;
  if(typeof value==="string"){
    if(!["supplierName","itemName","name","label"].includes(key))return null;
    const text=safeText(value);
    return text?catalog.fields[key]+": "+text:null;
  }
  if(typeof value==="number"&&Number.isSafeInteger(value)&&
    Math.abs(value)<=1_000_000_000_000){
    if(key==="packageCount" && id==="supplies.quotes"){
      // A price without its package unit is not a comparable quote.
      const unit=row.packageUnit;
      if(typeof unit!=="string" || !Object.hasOwn(catalog.units,unit))return null;
      const number=new Intl.NumberFormat(locale).format(value);
      return catalog.fields.packageCount+": "+number+" "+catalog.units[unit as Unit];
    }
    const formatted=key.endsWith("Cents")
      ?new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(value/100)
      :new Intl.NumberFormat(locale).format(value);
    return catalog.fields[key]+": "+formatted;
  }
  return null;
}
function previews(id:string,value:unknown,locale:Locale,fields:readonly Field[]):string[]{
  const rows=Array.isArray(value)?value:
    isRecord(value)&&Array.isArray(value.items)?value.items:[value];
  return rows.slice(0,2).filter(isRecord).map(row=>{
    const parts=fields.map(key=>displayedField(id,row,key,locale))
      .filter((x):x is string=>x!==null);
    // Do not describe estimated expenses/recurring bills as recorded actuals.
    if(id==="money.expense_entries"&&row.status==="estimated" ||
      id==="money.recurring_bill_rows"&&row.isEstimate===true)
      parts.unshift(catalogs[locale].alerts.estimated);
    return parts.join(" · ");
  }).filter(Boolean);
}

/** Called only on strictly registry-validated, authenticated P1 read results
 * inside an unchanged authoritative snapshot epoch bracket when available.
 * Independently read sources are always visibly provisional, not full totals.
 */
export function presentRegisteredReads(params:{
  evidence:readonly ShadowEvidence[];includedClauses:readonly string[];
  businessId:string;asOf:string;locale:Locale;
}):ReadView {
  const {evidence,includedClauses,businessId,asOf,locale}=params;
  const strings=catalogs[locale];
  const blocks:SupervisorReplyBlock[]=[];
  const refs:EvidenceReference[]=[];
  const selected=new Set(includedClauses);
  for(const item of evidence){
    if(!selected.has(item.clause)||!item.capabilityId ||
      !["verified","partial","estimated"].includes(item.status) ||
      !isRecord(item.result))continue;
    const result=item.result;
    if(!isRecord(result.provenance) ||
      result.provenance.asOf!==asOf ||
      typeof result.provenance.canonicalReaderId!=="string" ||
      typeof result.provenance.purpose!=="string" ||
      typeof result.id!=="string" ||
      item.capabilityId!=="p3."+result.id+".v1" ||
      !isRecord(result.quality) ||
      !Array.isArray(result.quality.missingInputs) ||
      !Array.isArray(result.quality.estimatedInputs) ||
      !Array.isArray(result.quality.staleInputs) ||
      !Object.hasOwn(result,"value"))continue;
    const contract=sources[result.id];
    if(!contract)continue;
    const ref:EvidenceReference={source:"cafe_state",
      identifier:"p3:read:"+createHash("sha256").update(JSON.stringify({
        businessId,asOf,capabilityId:item.capabilityId,query:result.query,
        canonicalReaderId:result.provenance.canonicalReaderId,
        value:result.value,quality:result.quality,
      })).digest("hex").slice(0,32),asOf};
    const rendered=previews(result.id,result.value,locale,contract.fields);
    blocks.push({type:"text",text:strings.headings[contract.heading]+": "+strings.alerts.partial});
    for(const text of rendered)blocks.push({type:"text",text:text.slice(0,1150)});
    if(!rendered.length)blocks.push({type:"text",text:strings.alerts.empty});
    blocks.push({type:"warning",code:"P3_READ_PARTIAL",text:strings.alerts.quality});
    if(Array.isArray(result.value) && result.value.length>2 ||
      isRecord(result.value)&&Array.isArray(result.value.items)&&result.value.items.length>2)
      blocks.push({type:"text",text:strings.alerts.more});
    refs.push(ref);
    if(blocks.length>=22)break;
  }
  return {blocks:blocks.slice(0,24),evidence:refs.slice(0,8)};
}
