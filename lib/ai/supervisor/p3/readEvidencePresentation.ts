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
  "priceDeltaCents" | "ingredientCostDeltaCents" | "targetPriceCents" |
  "ingredientContributionDeltaCents" | "assumptionCodes" | "costBasisEstimated" |
  "alternateStatus" | "changed" | "completeCoverageAfter" | "gapsDifference" |
  "loadedPayrollDifferenceCents" | "legalReviewUnverified" | "hasAdditionalCaveats" |
  "overridesSummary" | "objective" | "changesSummary" | "ownerMinutesDifference" |
  "cashWagesDifferenceCents" | "salaryAllocationIncluded" | "laborCostEstimated";
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
/** Exhaustive map of the specific `reason` codes a registered P3 capability's
 * own unavailable result can carry -- confirmed by reading each capability's
 * source (lib/pricing/alexCapabilities.server.ts, lib/pricing/alexPricing.ts,
 * lib/pricing/alexP3Capabilities.server.ts, lib/scheduling/oliviaP3Capabilities.server.ts,
 * lib/scheduling/oliviaCapabilityContracts.ts, lib/metrics/p1AtomicSourceSnapshot.server.ts)
 * -- to a localized, actionable owner-facing sentence. An unrecognized code
 * returns null so the caller falls back to the generic missing_input text;
 * a raw internal code is never shown to the owner. */
const specificUnavailableReasonLabels:Record<string,CatalogKey> = {
  unauthorized_or_unsupported_currency:"reason_notAuthorizedOrCurrency",
  source_scope_mismatch:"reason_sourceChanged",
  invalid_trusted_clock:"reason_clockUnverified",
  source_revision_changed_or_unavailable:"reason_sourceChanged",
  no_ready_items:"reason_noReadyMenuItems",
  product_not_found:"reason_productNotFound",
  ambiguous_canonical_name_use_product_id:"reason_ambiguousProductName",
  price_delta_requires_recorded_price:"reason_noRecordedPrice",
  proposed_price_out_of_range:"reason_priceOutOfRange",
  ingredient_scenario_requires_complete_priced_recipe:"reason_recipeIncomplete",
  hypothetical_cost_inputs_incomplete:"reason_ingredientCostsIncomplete",
  cost_basis_unavailable_for_target:"reason_noCostBasisForTarget",
  cost_basis_unavailable_for_impact:"reason_noCostBasisForImpact",
  owner_total_cost_fallback_not_in_atomic_snapshot:"reason_totalCostUnavailable",
  owner_total_cost_missing:"reason_noCostBasisAtAll",
  source_truncated_or_unsupported_currency:"reason_sourceTooLargeOrUnsupported",
  no_feasible_schedule:"reason_noFeasibleSchedule",
  wage_data_incomplete:"reason_wageDataIncomplete",
  unexpected_capability:"reason_schedulingUnavailable",
  employee_not_found:"reason_employeeNotFound",
  ambiguous_employee_name:"reason_ambiguousEmployeeName",
  ingredient_not_found:"reason_ingredientNotFound",
  ambiguous_ingredient_name:"reason_ambiguousIngredientName",
  ingredient_catalog_truncated:"reason_ingredientCatalogTruncated",
  invalid_input:"reason_invalidSchedulingRequest",
  unauthorized:"reason_notAuthorized",
  disabled:"reason_featureDisabled",
  not_found:"reason_notFound",
  missing_inputs:"reason_schedulingInputsMissing",
  source_changed:"reason_sourceChanged",
  revision_conflict:"reason_sourceChanged",
  invalid_record:"reason_invalidSchedulingRequest",
  storage_unavailable:"reason_temporarilyUnavailable",
  planner_unavailable:"reason_temporarilyUnavailable",
  capacity_exceeded:"reason_requestTooLarge",
  rpc_not_installed:"reason_temporarilyUnavailable",
  unauthorized_or_unconfigured:"reason_notAuthorized",
  invalid_source_snapshot:"reason_temporarilyUnavailable",
};
export function specificCapabilityUnavailableReason(locale:Locale,reason:string):string|null{
  if(Object.hasOwn(specificUnavailableReasonLabels,reason))
    return t(locale,specificUnavailableReasonLabels[reason]);
  // A dynamic per-ingredient suffix (":<uuid>") is never shown raw to an
  // owner; match the stable prefix instead.
  if(reason.startsWith("ambiguous_or_invalid_ingredient_price:"))
    return t(locale,"reason_ingredientPriceAmbiguous");
  return null;
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
    fields:["name","changesSummary","priceDeltaCents","ingredientCostDeltaCents","ingredientContributionDeltaCents",
      "targetPriceCents","assumptionCodes","costBasisEstimated"],
  },
  "olivia.schedule.what_if":{
    heading:"source_olivia_schedule_what_if",
    fields:["name","overridesSummary","objective","alternateStatus","changed","completeCoverageAfter",
      "gapsDifference","loadedPayrollDifferenceCents",
      "ownerMinutesDifference","cashWagesDifferenceCents","salaryAllocationIncluded","laborCostEstimated",
      "legalReviewUnverified","hasAdditionalCaveats"],
  },
};
const scheduleStatusLabels:Record<string,CatalogKey> = {
  feasible:"scheduleStatus_feasible", infeasible:"scheduleStatus_infeasible",
  unproven:"scheduleStatus_unproven",
};
const scheduleObjectiveLabels:Record<string,CatalogKey> = {
  cash:"objective_cash", owner_time:"objective_ownerTime", balanced:"objective_balanced",
};
// Longer than safeText's generic 120-char cutoff on purpose: the employee name alone is
// allowed up to 240 chars by overrideSummaryItem's own schema, and safeText's cap silently
// dropped a whole valid, in-bounds override line for a longer-but-real name. Caught in
// review (PR #108, round 4).
const safeOverrideName=(value:string):string|null=>{
  const text=value.replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
  return text && text.length<=240 && !/https?:\/\/|www\./iu.test(text)?text:null;
};
/** Renders one structured override entry through the locale catalogs -- never pre-
 * assembled English prose, so ES/AR owners see a fully localized line, not English
 * fragments inside an otherwise-localized reply. Caught in review (PR #108, round 4). */
function overrideSummaryLine(o:Record<string,unknown>,locale:Locale):string|null{
  const name=typeof o.employeeName==="string"?safeOverrideName(o.employeeName):null;
  if(!name)return null;
  if(o.kind==="temporary_unavailable" && typeof o.localDate==="string"){
    const window=typeof o.startLocal==="string" && typeof o.endLocal==="string"
      ?" ("+o.startLocal+"–"+o.endLocal+")":" "+t(locale,"override_allDay");
    return name+" "+t(locale,"override_unavailable")+" "+o.localDate+window;
  }
  if(o.kind==="reduce_weekly_minutes" && typeof o.maxWeeklyMinutes==="number")
    return name+" "+t(locale,"override_cappedAt")+" "+o.maxWeeklyMinutes+" "+t(locale,"override_minPerWeek");
  if(o.kind==="reduce_daily_minutes" && typeof o.maxMinutes==="number" && typeof o.localDate==="string")
    return name+" "+t(locale,"override_cappedAt")+" "+o.maxMinutes+" "+t(locale,"override_minOn")+" "+o.localDate;
  return null;
}
/** Exhaustive map of Alex's own enumerable what-if caveat codes (never free text — see
 * ALEX_ASSUMPTION_CODES in alexP3Capabilities.server.ts) to a localized plain-language string.
 * An unrecognized code is dropped, never shown as a raw internal value (caught in review). */
const assumptionCodeLabels:Record<string,CatalogKey> = {
  owner_hypothetical_not_recorded:"assumption_ownerHypotheticalNotRecorded",
  recorded_cost_freshness_not_proven:"assumption_recordedCostFreshnessNotProven",
  owner_total_is_aggregate_not_ingredient_recipe:"assumption_ownerTotalIsAggregate",
  ingredient_only_excludes_labor_fees_rent_and_demand:"assumption_ingredientOnlyExcludesOverhead",
  owner_supplied_ingredient_cost_overrides_are_hypothetical:"assumption_ownerSuppliedOverrides",
  no_target_selected_no_target_price:"assumption_noTargetSelected",
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
  ingredientContributionDeltaCents:"field_ingredientContributionDeltaCents",
  assumptionCodes:"field_assumptionsSummary",
  costBasisEstimated:"field_costBasisEstimated",
  alternateStatus:"field_alternateStatus",
  changed:"field_scheduleChanged",
  completeCoverageAfter:"field_completeCoverageAfter",
  gapsDifference:"field_gapsDifference",
  loadedPayrollDifferenceCents:"field_loadedPayrollDifferenceCents",
  legalReviewUnverified:"field_legalReviewUnverified",
  hasAdditionalCaveats:"field_hasAdditionalCaveats",
  overridesSummary:"field_overridesSummary",
  objective:"field_objective",
  changesSummary:"field_changesSummary",
  ownerMinutesDifference:"field_ownerMinutesDifference",
  cashWagesDifferenceCents:"field_cashWagesDifferenceCents",
  salaryAllocationIncluded:"field_salaryAllocationIncluded",
  laborCostEstimated:"field_laborCostEstimated",
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
  if(key==="alternateStatus"){
    return typeof value==="string" && Object.hasOwn(scheduleStatusLabels,value)
      ?t(locale,fieldLabel[key])+": "+t(locale,scheduleStatusLabels[value]):null;
  }
  if(key==="objective"){
    return typeof value==="string" && Object.hasOwn(scheduleObjectiveLabels,value)
      ?t(locale,fieldLabel[key])+": "+t(locale,scheduleObjectiveLabels[value]):null;
  }
  // Structured entries, not pre-assembled English sentences: each line is rendered
  // through the EN/ES/AR catalogs here, where the owner's locale is actually known.
  // Only the employee name (owner-entered free text, up to 240 chars here) needs the
  // generic control-char/URL sanitizer; it uses its OWN length bound (safeText's 120-char
  // cutoff silently dropped a whole valid, in-bounds override line for a longer name).
  // Caught in review (PR #108, round 4).
  if(key==="overridesSummary"){
    if(!Array.isArray(value)||!value.length)return null;
    const lines=value.filter(isRecord).map(o=>overrideSummaryLine(o,locale))
      .filter((x):x is string=>x!==null);
    return lines.length?t(locale,fieldLabel[key])+": "+lines.join("; "):null;
  }
  // Unlike costBasisEstimated (only shown when true), both true and false are
  // meaningful here: "nothing changed" and "coverage stayed complete" are real,
  // reassuring answers to a what-if, not the absence of one.
  if(key==="changed"||key==="completeCoverageAfter")
    return typeof value==="boolean"
      ?t(locale,fieldLabel[key])+": "+t(locale,value?"yesValue":"noValue"):null;
  // Unlike changed/completeCoverageAfter, these are caveats only worth a line when
  // true -- same true-only pattern as costBasisEstimated below.
  if(key==="legalReviewUnverified"||key==="hasAdditionalCaveats"||key==="salaryAllocationIncluded"||key==="laborCostEstimated")
    return value===true?t(locale,fieldLabel[key]):null;
  if(key==="assumptionCodes"){
    if(!Array.isArray(value)||!value.length)return null;
    // 3, not 2: matches the upstream cap in alexP3Capabilities.server.ts's output schema
    // (raised in review, round 9) -- an owner-total cost basis needs both its own caveat
    // and the cost-freshness one alongside the always-present ingredient-only caveat.
    const labels=value.filter((c):c is string=>typeof c==="string"&&Object.hasOwn(assumptionCodeLabels,c))
      .slice(0,3).map(c=>t(locale,assumptionCodeLabels[c]));
    return labels.length?t(locale,fieldLabel[key])+": "+labels.join("; "):null;
  }
  // quality.estimatedInputs's "owner_total_cost_estimated" signal, carried through as a
  // plain boolean: an owner-entered TOTAL that is itself an estimate (not a recorded real
  // figure) must be labeled as such per this project's own estimate-labeling rule, and was
  // previously dropped entirely (this capability's presentation never rendered `quality` at
  // all beyond a generic warning). Caught in review (round 9).
  if(key==="costBasisEstimated")
    return value===true?t(locale,fieldLabel[key]):null;
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
/** Typed scenario parameters are echoed using locale labels, never raw JSON/UUIDs. */
function ingredientChangeLine(o:Record<string,unknown>,locale:Locale):string|null{
  const name=typeof o.ingredientName==="string"?safeOverrideName(o.ingredientName):
    typeof o.fromIngredientName==="string"?safeOverrideName(o.fromIngredientName):null;
  if(!name)return null;
  const amount=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)
    ?new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(value):null;
  const units:Record<string,CatalogKey>={ml:"unit_ml",g:"unit_g",fl_oz:"unit_fl_oz",each:"unit_each",gal:"unit_gal"};
  const quantity=(q:unknown)=>isRecord(q)&&typeof q.unit==="string"&&Object.hasOwn(units,q.unit)
    ?amount(q.value)+" "+t(locale,units[q.unit]):null;
  let detail:string|null=null;
  if(o.kind==="ingredient_multiplier")detail=t(locale,"change_ingredient_multiplier")+": "+amount(o.multiplierBasisPoints);
  if(o.kind==="ingredient_unit_cost")detail=t(locale,"change_ingredient_unit_cost")+": "+new Intl.NumberFormat(locale,{style:"currency",currency:"USD",maximumFractionDigits:8}).format(Number(o.costPerBaseUnitMicros)/100000000);
  if(o.kind==="supplier_package"&&typeof o.packageUnit==="string"&&Object.hasOwn(units,o.packageUnit))
    detail=t(locale,"change_supplier_package")+": "+new Intl.NumberFormat(locale,{style:"currency",currency:"USD"})
      .format(Number(o.packageCostCents)/100)+" / "+amount(o.packageCount)+" "+t(locale,units[o.packageUnit]);
  if(o.kind==="set_quantity")detail=t(locale,"change_set_quantity")+": "+quantity(o.quantity);
  if(o.kind==="replace_ingredient"&&typeof o.toIngredientName==="string"){
    const target=safeOverrideName(o.toIngredientName);
    if(target)detail=t(locale,"change_replace_ingredient")+" "+target+
      (o.quantity?" ("+quantity(o.quantity)+")":"");
  }
  return detail?t(locale,"field_changesSummary")+": "+name+" · "+detail:null;
}
function previews(id:string,value:unknown,locale:Locale,
  fields:readonly PresentedField[]):string[]{
  const rows=Array.isArray(value)?value:
    isRecord(value)&&Array.isArray(value.items)?value.items:[value];
  return rows.slice(0,2).filter(isRecord).flatMap(row=>{
    const parts=fields.flatMap(field=>field==="changesSummary" && Array.isArray(row[field])
      ? row[field].filter(isRecord).map(o=>ingredientChangeLine(o,locale))
      : field==="overridesSummary" && Array.isArray(row[field])
      ? row[field].filter(isRecord).map(o=>{
        const line=overrideSummaryLine(o,locale);
        return line?t(locale,"field_overridesSummary")+": "+line:null;
      })
      : [displayedField(id,row,field,locale)])
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
    // Pack complete fields into bounded blocks. Never truncate an override,
    // computed result or caveat after joining long employee names.
    const chunks:string[]=[];
    for(const part of parts){
      const last=chunks.length-1;
      if(last>=0 && chunks[last].length+3+part.length<=1150)
        chunks[last]+=" · "+part;
      else chunks.push(part);
    }
    return chunks;
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
    for(const text of rendered)blocks.push({type:"text",text});
    if(!rendered.length)blocks.push({type:"text",text:t(locale,"empty")});
    blocks.push({type:"warning",code:"P3_READ_PARTIAL",text:t(locale,"quality")});
    if(Array.isArray(result.value) && result.value.length>2 ||
      isRecord(result.value)&&Array.isArray(result.value.items)&&result.value.items.length>2)
      blocks.push({type:"text",text:t(locale,"more")});
    refs.push(ref);
  }
  // Fail explicitly when all selected evidence cannot fit. Cutting a source
  // section could remove its computed result or safety caveats after long inputs.
  if(blocks.length>24)return {blocks:[{type:"warning",code:"P3_PRESENTATION_LIMIT",
    text:t(locale,"reason_requestTooLarge")}],evidence:[]};
  return {blocks,evidence:refs.slice(0,8)};
}
