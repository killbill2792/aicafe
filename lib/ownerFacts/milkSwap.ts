import {createHash} from "node:crypto";
import {swapCostPerSize,DEFAULT_TARGET_PRODUCT_COST_PERCENT} from "@/lib/metrics/core/modifierPricing";
import {itemIngredientCostCents} from "@/lib/calc/ingredients";
import {roundHalfUpToCent} from "@/lib/calc/money";
import type {SavedFact} from "./inject";
import {savedValue} from "./inject";
import type {AgentToolResult} from "@/lib/ai/agent/tools";
import type {ExplainLine} from "@/lib/ai/agent/explain";
import {money} from "@/lib/ai/agent/explain";

/** C adapts stored source records to B's modifier-pricing engine.
 * All customer upcharges and cost deltas come from that shared module. */
export type MilkSize={id:string;label:string};
export function requestedMilkSizes(text:string):MilkSize[]{
 const localized=text.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,digit=>{
  const code=digit.charCodeAt(0);return String(code>=0x6f0?code-0x6f0:code-0x660);
 });
 const values=[...localized.matchAll(/(\d{1,2})\s*(?:fl\s*)?(?:oz|ounce|onzas|أونصة)/giu)]
   .map(match=>Number(match[1])).filter(n=>n>0&&n<=64);
 return [...new Set(values)].slice(0,3).map(n=>({id:n+"oz",label:n+" oz"}));
}
type CostRow={name?:unknown;ingredient_name?:unknown;baseUnit?:unknown;base_unit?:unknown;
 costPerBaseUnitMicros?:unknown;cost_per_base_unit_micros?:unknown;
 size?:unknown;size_label?:unknown;ml?:unknown;milk_ml?:unknown;milkMl?:unknown;
 category?:unknown;ingredient_category?:unknown;category_name?:unknown;group_name?:unknown;
 data?:unknown};
function flattenCanonicalRow(raw:object):CostRow{
 const row=raw as CostRow;
 return row.data&&typeof row.data==="object"&&!Array.isArray(row.data)?
  {...row.data as Record<string,unknown>,...row}:row;
}
function observedVolume(size:MilkSize,results:readonly AgentToolResult[]):number|null{
 for(const result of results)for(const item of [
   ...(Array.isArray(result.rows)?result.rows:[]),
   ...(Array.isArray(result.items)?result.items:[])
 ]){
  if(!item||typeof item!=="object")continue;
  const row=flattenCanonicalRow(item);
  const sizeDescription=String(row.size??row.size_label??row.name??"").toLowerCase();
  const n=Number(size.id.replace("oz",""));
  const matchedSize=sizeDescription.match(/(?:^|[^0-9])([0-9]{1,2})\s*(?:fl\s*)?(?:oz|ounce|onzas)(?:$|[^a-z])/iu);
  if(!matchedSize||Number(matchedSize[1])!==n)continue;
  const value=row.milkMl??row.milk_ml??row.ml;
  if(typeof value==="number"&&Number.isFinite(value)&&value>0)return value;
 }
 return null;
}
function observedMicros(name:string,results:readonly AgentToolResult[]):number|null{
 const match=name.trim().toLowerCase();
 if(!match)return null;
 for(const result of results){
  const list=[...(Array.isArray(result.items)?result.items:[]),...(Array.isArray(result.rows)?result.rows:[])];
  for(const unknown of list){
   if(!unknown||typeof unknown!=="object")continue;
   const row=flattenCanonicalRow(unknown),rawName=row.name??row.ingredient_name;
   const rawUnit=row.baseUnit??row.base_unit;
   const value=row.costPerBaseUnitMicros??row.cost_per_base_unit_micros;
   if(typeof rawName!=="string"||rawName.trim().toLowerCase()!==match||
     rawUnit!=="ml"||typeof value!=="number"||!Number.isSafeInteger(value)||value<0)continue;
   return value;
  }
 }
 return null;
}
export type MilkSwapLine={sizeId:string;sizeLabel:string;volumeMl:number|null;
 baseServingCents:number|null;oatServingCents:number|null;targetServingCents:number|null;additionalCostCents:number|null;
 suggestedUpchargeCents:number|null;basis:"estimated"|"missing";
 inputBasis:"owner_provided"|"recorded"|"mixed"|"unknown";
 targetProductCostPercent?:number|null;roundingStepCents?:number};
export type MilkSwapAnswer={source:"milk_swap";period:null;missing:string[];targetMilk:string|null;
 rows:MilkSwapLine[];explain:ExplainLine[];numberEstimates:{value:number;unit:"cents";detail:"pricing"}[]};
/** ASCII keys are stable for menu names in any script and scoped to the milk. */
export function milkFactToken(name:string):string{
 const normalized=name.trim().toLocaleLowerCase("und")
   .replace(/\bmilk\b/giu,"").replace(/\bleche(?: de)?\b/giu,"").trim();
 const ascii=normalized.replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
 return ascii?ascii.slice(0,45):"named_"+createHash("sha256").update(name.normalize("NFC"))
   .digest("hex").slice(0,16);
}
const servingKey=(type:string,sizeId:string)=>"milk_"+(type==="base"?"base":milkFactToken(type))+"_serving_cost_cents:"+sizeId;
const volumeKey=(sizeId:string)=>"milk_ml:"+sizeId;
const validNumber=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
const costFromFacts=(facts:readonly SavedFact[],key:string):number|null=>{
 const n=savedValue(facts,key);return validNumber(n)?n:null;
};
/** Transitional read only: facts saved before milk-name normalization used
 * "almond_milk" instead of "almond". Never ask the owner to enter them twice. */
function storedServingCost(facts:readonly SavedFact[],milk:string,sizeId:string):number|null{
 const current=costFromFacts(facts,servingKey(milk,sizeId));
 if(current!==null||milk==="base")return current;
 const oldToken=milk.trim().toLocaleLowerCase("und")
  .replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
 return oldToken&&oldToken!==milkFactToken(milk)?
  costFromFacts(facts,"milk_"+oldToken+"_serving_cost_cents:"+sizeId):null;
}
function sharedServingCost(volume:number|null,costMicros:number|null):number|null{
 if(volume===null||costMicros===null)return null;
 // Shared ingredient engine alone owns volume × per-ml ingredient cost.
 return roundHalfUpToCent(itemIngredientCostCents(
  [{ingredientId:"milk",quantity:volume}],{milk:costMicros}));
}
/** Unit conversion only: persisted per-serving cents into microcents/ml. */
function servingMicros(cents:number|null,volume:number|null):number|null{
 if(cents===null||volume===null||volume<=0)return null;
 const value=Math.round(cents*1_000_000/volume);
 return Number.isSafeInteger(value)&&value>=0?value:null;
}
export function milkSwapFromFacts(sizes:readonly MilkSize[],facts:readonly SavedFact[],
 results:readonly AgentToolResult[],targetMilk:string|null=null,baseMilk:string|null=null):MilkSwapAnswer{
 const milkType=savedValue(facts,"milk_base_type");
 const fromMilk=baseMilk?.trim()||(typeof milkType==="string"&&milkType.trim()?milkType.trim():null);
 const fromMicros=fromMilk?observedMicros(fromMilk,results):null;
 const savedTarget=savedValue(facts,"milk_target_type");
 const toMilk=targetMilk?.trim()||(typeof savedTarget==="string"&&savedTarget.trim()?savedTarget.trim():null);
 const toMicros=toMilk?observedMicros(toMilk,results):null;
 const missing=new Set<string>();
 if(!fromMilk)missing.add("milk_base_type");
 if(!toMilk)missing.add("milk_target_type");
 const rows=sizes.map(size=>{
  // A fresh recorded recipe beats a prior owner fallback after a menu edit.
  const recordedVolume=observedVolume(size,results);
  const v=recordedVolume??costFromFacts(facts,volumeKey(size.id));
  const volume=v!==null&&v>0?v:null;
  const savedBaseName=typeof milkType==="string"?milkType.trim().toLocaleLowerCase("und"):"";
  const matchesSavedBase=!!fromMilk&&fromMilk.toLocaleLowerCase("und")===savedBaseName;
  const baseCost=sharedServingCost(volume,fromMicros)??(fromMilk?
   (matchesSavedBase?storedServingCost(facts,"base",size.id):storedServingCost(facts,fromMilk,size.id)):null);
  const oatCost=sharedServingCost(volume,toMicros)??(toMilk?storedServingCost(facts,toMilk,size.id):null);
  const inputs=[recordedVolume!==null?"recorded":volume!==null?"owner_provided":"unknown",
    fromMicros!==null?"recorded":baseCost!==null?"owner_provided":"unknown",
    toMicros!==null?"recorded":oatCost!==null?"owner_provided":"unknown"];
  const inputBasis=inputs.includes("unknown")?"unknown" as const:
    inputs.every(v=>v==="owner_provided")?"owner_provided" as const:
    inputs.every(v=>v==="recorded")?"recorded" as const:"mixed" as const;
  if(volume===null)missing.add(volumeKey(size.id));
  // When the café has recorded per-mL costs, the only missing input may be
  // serving volume. Don't ask twice for prices that can be derived afterward.
  if(baseCost===null&&fromMicros===null)missing.add(servingKey(matchesSavedBase?"base":fromMilk??"base",size.id));
  if(toMilk&&oatCost===null&&toMicros===null)missing.add(servingKey(toMilk,size.id));
  if(!fromMilk||!toMilk||volume===null||baseCost===null||oatCost===null)
   return {sizeId:size.id,sizeLabel:size.label,volumeMl:volume,
    baseServingCents:baseCost,oatServingCents:oatCost,targetServingCents:oatCost,
    additionalCostCents:null,suggestedUpchargeCents:null,basis:"missing" as const,inputBasis};
  const fromUnit=fromMicros??servingMicros(baseCost,volume);
  const toUnit=toMicros??servingMicros(oatCost,volume);
  // B alone computes the delta and rounded recommendation. A recorded
  // microcost always wins over an older owner per-serving fallback.
  const priced=swapCostPerSize([size],fromMilk,toMilk,
   {[size.id]:{ml:volume,basis:costFromFacts(facts,volumeKey(size.id))!==null?
      "owner_provided" as const:"recorded" as const}},
   {[fromMilk]:{costPerMlMicros:fromUnit,basis:fromMicros!==null?
      "recorded" as const:"owner_provided" as const},
    [toMilk]:{costPerMlMicros:toUnit,basis:toMicros!==null?
      "recorded" as const:"owner_provided" as const}},
   DEFAULT_TARGET_PRODUCT_COST_PERCENT,"estimated").sizes[0];
  return {sizeId:size.id,sizeLabel:size.label,volumeMl:volume,
   baseServingCents:baseCost,oatServingCents:oatCost,targetServingCents:oatCost,
   additionalCostCents:priced.costDeltaCents,
   suggestedUpchargeCents:priced.suggestedUpchargeCents,basis:"estimated" as const,inputBasis,
   targetProductCostPercent:priced.targetProductCostPercent,roundingStepCents:priced.roundingStepCents};
 });
 const explain:ExplainLine[]=rows.flatMap(row=>row.suggestedUpchargeCents===null?[]:[
   ...((row.oatServingCents!-row.baseServingCents!)===row.additionalCostCents?[
     {label:"Milk cost difference",inputs:[
       {name:"baseMilkCost",value:money(row.baseServingCents!)},
       {name:"targetMilkCost",value:money(row.targetServingCents!)}],
      formula:"subtract" as const,result:money(row.additionalCostCents!),
      period:null,source:"milk_swap",provenance:"estimate" as const,basis:"estimated"}
   ]:[]),
   {label:"Suggested upcharge",inputs:[
     {name:"costDeltaCents",value:money(row.additionalCostCents!)},
     {name:"targetProductCostPercent",value:{kind:"percent" as const,bps:Math.round(row.targetProductCostPercent!*10000)}},
     {name:"roundingStepCents",value:money(row.roundingStepCents!)}],
    formula:"divide" as const,result:money(row.suggestedUpchargeCents),
    period:null,source:"milk_swap",provenance:"estimate" as const,basis:"estimated"}
 ]);
 return {source:"milk_swap",period:null,missing:[...missing],targetMilk:toMilk,rows,explain,
  numberEstimates:rows.flatMap(row=>row.suggestedUpchargeCents===null?[]:
   [{value:row.suggestedUpchargeCents,unit:"cents" as const,detail:"pricing" as const}])};
}
