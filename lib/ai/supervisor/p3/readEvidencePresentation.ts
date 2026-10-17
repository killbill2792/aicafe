import { createHash } from "node:crypto";
import enCatalog from "@/messages/en.json";
import esCatalog from "@/messages/es.json";
import arCatalog from "@/messages/ar.json";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { EvidenceReference, SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";

type Locale = "en" | "es" | "ar";
type ReadView = { blocks: SupervisorReplyBlock[]; evidence: EvidenceReference[] };
type CatalogKey = keyof typeof enCatalog.SupervisorRegisteredRead;
type PresentedField = "supplierName" | "itemName" | "priceCents" |
  "packageCount" | "name" | "label" | "amountCents" | "totalCents" |
  "defaultHourlyWageCents" | "wageAmountCents" | "ingredientsCentsToday" |
  "currentPriceCents" | "reviewIngredientCostCents" | "currentRecommendationCents" |
  "loadedLaborCostCents" | "shiftCount" |
  "priceDeltaCents" | "ingredientCostDeltaCents" | "targetPriceCents";
const dictionaries = {
  en:enCatalog.SupervisorRegisteredRead,
  es:esCatalog.SupervisorRegisteredRead,
  ar:arCatalog.SupervisorRegisteredRead,
};
const t=(locale:Locale,key:CatalogKey):string=>dictionaries[locale][key];
export function registeredReadReason(locale:Locale,reason:
  "unsupported"|"missing_input"|"unsupported_action"):string {
  const names={
    unsupported:"unsupportedOutcome",
    missing_input:"missingInput",
    unsupported_action:"unsupportedAction",
  } as const satisfies Record<typeof reason,CatalogKey>;
  return t(locale,names[reason]);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const packageUnitKeys = {
  each:"unit_each", oz:"unit_oz",lb:"unit_lb",kg:"unit_kg",gal:"unit_gal",
  liter:"unit_liter",case:"unit_case",
} as const satisfies Record<string,CatalogKey>;

/** A domain record is displayed ONLY after its P1 reader validates the shape.
 * These locale catalog keys and bounded fields are reviewed source contracts,
 * never model-provided labels or mutable source enumeration strings.
 */
const sourcePresentation:Record<string,{
  heading:CatalogKey;fields:readonly PresentedField[];
}> = {
  "supplies.quotes":{
    heading:"source_supplies_quotes",
    fields:["supplierName","itemName","priceCents","packageCount"],
  },
  "menu.catalog":{
    heading:"source_menu_catalog",fields:["name","priceCents"],
  },
  "menu.product_economics":{
    heading:"source_menu_product_economics",
    fields:["name","priceCents","ingredientsCentsToday"],
  },
  "menu.ingredients":{
    heading:"source_menu_ingredients",fields:["name"],
  },
  "labor.employee_wages":{
    heading:"source_labor_employee_wages",
    fields:["name","defaultHourlyWageCents","wageAmountCents"],
  },
  "money.monthly_bills":{
    heading:"source_money_monthly_bills",fields:["totalCents"],
  },
  "money.recurring_bill_rows":{
    heading:"source_money_recurring_bill_rows",fields:["label","amountCents"],
  },
  "money.recorded_spending":{
    heading:"source_money_recorded_spending",fields:["totalCents"],
  },
  "money.expense_entries":{
    heading:"source_money_expense_entries",fields:["amountCents"],
  },
  "alex.pricing.review":{
    heading:"source_alex_pricing_review",
    fields:["name","currentPriceCents","reviewIngredientCostCents","currentRecommendationCents"],
  },
  "olivia.schedule.preview":{
    heading:"source_olivia_schedule_preview",
    fields:["name","loadedLaborCostCents","shiftCount"],
  },
  "alex.pricing.what_if":{
    heading:"source_alex_pricing_what_if",
    fields:["name","priceDeltaCents","ingredientCostDeltaCents","targetPriceCents"],
  },
};
const fieldLabel:Record<PresentedField,CatalogKey> = {
  supplierName:"field_supplierName",itemName:"field_itemName",
  priceCents:"field_priceCents",packageCount:"field_packageCount",
  name:"field_name",label:"field_label",amountCents:"field_amountCents",
  totalCents:"field_totalCents",
  defaultHourlyWageCents:"field_defaultHourlyWageCents",
  wageAmountCents:"field_wageAmountCents",
  ingredientsCentsToday:"field_ingredientsCentsToday",
  currentPriceCents:"field_currentPriceCents",
  reviewIngredientCostCents:"field_reviewIngredientCostCents",
  currentRecommendationCents:"field_currentRecommendationCents",
  loadedLaborCostCents:"field_loadedLaborCostCents",
  shiftCount:"field_shiftCount",
  priceDeltaCents:"field_priceDeltaCents",
  ingredientCostDeltaCents:"field_ingredientCostDeltaCents",
  targetPriceCents:"field_targetPriceCents",
};
const safeText=(value:string):string|null=>{
  const text=value.replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
  return text && text.length<=120 && !/https?:\/\/|www\./iu.test(text)?text:null;
};
function displayedField(id:string,row:Record<string,unknown>,key:PresentedField,
  locale:Locale):string|null{
  const value=row[key];
  // Do not infer observed zero from unrelated missing inputs. Trust the
  // source's field-specific status instead. Recorded zero prices are retained.
  if(key==="priceCents" && id==="menu.catalog" && row.priceStatus!=="recorded")
    return null;
  if(key==="ingredientsCentsToday" &&
    (row.costStatus!=="READY"||
      !["recipe","owner_total"].includes(String(row.costSource))||
      !["actual","estimated"].includes(String(row.costQuality))))return null;
  if((key==="wageAmountCents"||key==="defaultHourlyWageCents") &&
    row.wageKnown!==true)return null;
  if(key==="defaultHourlyWageCents" && row.wagePeriod!=="hour")
    return null;
  if(key==="wageAmountCents" &&
    !["hour","month","year"].includes(String(row.wagePeriod)))return null;
  if(typeof value==="string"){
    if(!["supplierName","itemName","name","label"].includes(key))return null;
    const text=safeText(value);
    return text?t(locale,fieldLabel[key])+": "+text:null;
  }
  if(typeof value!=="number"||!Number.isSafeInteger(value)||
    Math.abs(value)>1_000_000_000_000)return null;
  if(key==="packageCount"){
    // A quote's quantity without unit can mislead supplier comparisons.
    const unit=row.packageUnit;
    if(typeof unit!=="string"||!Object.hasOwn(packageUnitKeys,unit))
      return null;
    const unitKey=packageUnitKeys[unit as keyof typeof packageUnitKeys];
    return t(locale,fieldLabel[key])+": "+
      new Intl.NumberFormat(locale).format(value)+" "+t(locale,unitKey);
  }
  const formatted=(key.endsWith("Cents")||key==="ingredientsCentsToday")
    ?new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(value/100)
    :new Intl.NumberFormat(locale).format(value);
  let heading:CatalogKey=key==="priceCents"&&id==="supplies.quotes"
    ?"field_quotePriceCents":fieldLabel[key];
  if(key==="ingredientsCentsToday"){
    if(row.costSource==="owner_total")heading=row.costQuality==="estimated"
      ?"field_ownerTotalCostEstimated":"field_ownerTotalCostRecorded";
    else if(row.costQuality==="estimated")heading="field_ingredientsCentsEstimated";
  }
  if(key==="wageAmountCents"){
    const period={
      hour:"period_hour",month:"period_month",year:"period_year",
    } as const satisfies Record<string,CatalogKey>;
    return t(locale,heading)+" ("+
      t(locale,period[row.wagePeriod as keyof typeof period])+"): "+formatted;
  }
  return t(locale,heading)+": "+formatted;
}
function previews(id:string,value:unknown,locale:Locale,
  fields:readonly PresentedField[]):string[]{
  const rows=Array.isArray(value)?value:
    isRecord(value)&&Array.isArray(value.items)?value.items:[value];
  return rows.slice(0,2).filter(isRecord).map(row=>{
    const parts=fields.map(field=>displayedField(id,row,field,locale))
      .filter((x):x is string=>x!==null);
    // Estimated ledger rows are not actual paid expenses. Owner-facing
    // labels are attached PER ROW, not as one generic footer.
    if(id==="money.expense_entries"){
      if(row.status==="estimated")parts.push(t(locale,"estimatedExpense"));
      else if(row.status==="actual")parts.push(t(locale,"actualExpense"));
      else return "";
    }
    if(id==="money.recurring_bill_rows"){
      if(row.isEstimate===true)parts.push(t(locale,"estimatedRecurring"));
      else parts.push(t(locale,"plannedRecurring"));
    }
    return parts.join(" · ");
  }).filter(Boolean);
}

/** Already-authorized P1 reads are ALWAYS provisional. The orchestration
 * validates stable P1 epochs before responding, but the canonical P1 read
 * itself supplies no immutable source revision. It must never be promoted to
 * verified profit, observed stock or completed business effects.
 */
export function presentRegisteredReads(params:{
  evidence:readonly ShadowEvidence[];includedClauses:readonly string[];
  businessId:string;asOf:string;locale:Locale;
}):ReadView {
  const {evidence,includedClauses,businessId,asOf,locale}=params;
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
    const presentation=sourcePresentation[result.id];
    // Future domain schemas must ship independently reviewed presentation
    // contracts; arbitrary new object keys are never reflected to the owner.
    if(!presentation)continue;
    const ref:EvidenceReference={source:"cafe_state",
      identifier:"p3:read:"+createHash("sha256").update(JSON.stringify({
        businessId,asOf,capabilityId:item.capabilityId,query:result.query,
        canonicalReaderId:result.provenance.canonicalReaderId,
        value:result.value,quality:result.quality,
      })).digest("hex").slice(0,32),asOf};
    const rendered=previews(result.id,result.value,locale,presentation.fields);
    blocks.push({type:"text",text:t(locale,presentation.heading)+": "+t(locale,"partial")});
    for(const text of rendered)blocks.push({type:"text",text:text.slice(0,1150)});
    if(!rendered.length)blocks.push({type:"text",text:t(locale,"empty")});
    blocks.push({type:"warning",code:"P3_READ_PARTIAL",text:t(locale,"quality")});
    if(Array.isArray(result.value) && result.value.length>2 ||
      isRecord(result.value)&&Array.isArray(result.value.items)&&result.value.items.length>2)
      blocks.push({type:"text",text:t(locale,"more")});
    refs.push(ref);
    if(blocks.length>=22)break;
  }
  return {blocks:blocks.slice(0,24),evidence:refs.slice(0,8)};
}
