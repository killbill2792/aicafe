import {scenarioEditorSchema,evaluateScenarioEditor} from "@/lib/ai/conversations/scenarioPresentation";
import {canonicalDictionary,canonicalViewNames,type CanonicalView} from "@/lib/data/canonical/dictionary";
import { z } from "zod";
import { richPresentationSchema,agendaSchema,scenarioComparisonSchema,recordTableSchema,interactiveCalcSchema,evaluatePresentationCalc,presentationLeaves,compatibleComparison,type RichPresentation,type RecordTable,type InteractiveCalc,type Agenda,type ScenarioComparison,type PresentationPanel } from "@/lib/ai/conversations/presentation";
import type { AgentToolContext,AgentToolResult } from "./index";

// Select a source projection, never supply a numeric value, arbitrary path or business identity.
const selection=z.strictObject({
  source:z.enum(["daily_rollups","item_sales","profitability","canonical_data","expenses","business_costs","product_costs","supplier_purchase_plan","purchase_orders","inventory","menu_items"]),
  field:z.string().trim().min(1).max(120),
  ref:z.string().regex(/^r[1-9][0-9]?$/).nullable().optional(),
  from:z.iso.date().nullable().optional(),to:z.iso.date().nullable().optional(),
  kind:z.enum(["metric","table","ranked_table","bar","line","donut"]),
});
export const presentationInputSchema=z.strictObject({
  layout:z.enum(["stack","grid"]),
  panels:z.array(selection).max(4),
  groups:z.array(z.strictObject({layout:z.enum(["stack","grid","compare"]),items:z.array(z.string().regex(/^(?:p[0-3]|agenda|scenario|calculator)$/)).min(1).max(7)})).max(7).nullable().optional(),
  agenda:z.enum(["calendar_events","timeline_events","calendar_shifts","timeline_shifts"]).nullable().optional(),
  scenario:z.enum(["monthly_profit","monthly_break_even","monthly_target_sales","item_margin"]).nullable().optional(),
  report:z.boolean().nullable().optional(),
  files:z.boolean().nullable().optional(),
  calculator:z.boolean().nullable().optional(),
  suggestions:z.array(z.string().trim().min(1).max(160)).max(3),
});
const descriptions={
 daily_sales:{source:"daily_rollups",title:"Daily net sales",unit:"cents"},
 item_units:{source:"item_sales",title:"Units sold",unit:"count"},
 net_sales:{source:"profitability",title:"Net sales",unit:"cents"},
 total_costs:{source:"profitability",title:"Total costs",unit:"cents"},
 owner_profit:{source:"profitability",title:"Owner profit",unit:"cents"},
} as const;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
// Project already scoped canonical results using the existing field dictionary.
// No additional reads, arbitrary JSON paths, model-authored units or aggregation.
const blockedViews=new Set(["cv_inventory","cv_owner_facts","cv_bills","cv_staff"]);
function queryScope(args:Record<string,unknown>,columns:Record<string,{unit:string}>):string{
 const filters=Array.isArray(args.filters)?args.filters:[];
 return filters.flatMap(f=>{
  if(!obj(f)||typeof f.column!=="string"||typeof f.op!=="string")return [];
  const unit=columns[f.column]?.unit;
  if(!unit||["identifier","UUID","JSON"].includes(unit))return [f.column+" "+f.op+" (scoped value)"];
  const value=Array.isArray(f.value)?f.value.map(String).join(", "):String(f.value??"");
  return [f.column+" "+f.op+" "+value.slice(0,80)];
 }).join("; ");
}
function canonicalPanel(s:z.infer<typeof selection>,r:AgentToolResult,encoded:string,ctx:Pick<AgentToolContext,"currency"|"asOf">):PresentationPanel|null{
 if(r.source!=="canonical_data"||r.empty||r.truncated||r.error||!r.period||
     r.period.to>ctx.asOf||!Array.isArray(r.rows)||r.rows.length<1||r.rows.length>30)return null;
 let args:unknown;try{args=JSON.parse(encoded);}catch{return null;}
 if(!obj(args)||typeof args.view!=="string"||!canonicalViewNames.includes(args.view as CanonicalView)||blockedViews.has(args.view)||
    !Array.isArray(args.metrics)||args.date_from!==r.period.from||args.date_to!==r.period.to)return null;
 const view=args.view as CanonicalView;
 const columns=canonicalDictionary[view].columns as Record<string,{unit:string;meaning:string}>;
 const m=args.metrics.find(x=>obj(x)&&typeof x.fn==="string"&&typeof x.column==="string"&&x.fn+"_"+x.column===s.field);
 if(!obj(m)||typeof m.fn!=="string"||typeof m.column!=="string"||!Object.hasOwn(columns,m.column))return null;
 const units=["cents","count","items","units","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour"] as const;
 const rawUnit=columns[m.column].unit;
 const unit=m.fn==="count"||m.fn==="count_distinct"||rawUnit==="indicator"&&m.fn==="sum"?"count":rawUnit;
 const partial=r.missing.length>0||Boolean(r.scopeWarning)||obj(r.aggregate)&&r.aggregate.status==="so_far";
 // Raw Toast fallback is scoped to explicit record counts, not guessed JSON units or screen totals.
 if(view==="cv_toast_records"&&(!["count","count_distinct"].includes(m.fn)||!["source_ref","record_ref","order_ref","check_ref"].includes(m.column)||!Array.isArray(args.filters)||!args.filters.some(f=>obj(f)&&f.column==="record_type"&&["=","in"].includes(String(f.op)))||!args.filters.some(f=>obj(f)&&f.column==="counts_in_sales"&&f.op==="="&&f.value===true)))return null;
 if(!units.includes(unit as typeof units[number])||!["sum","count","count_distinct","min","max","avg"].includes(m.fn))return null;
 const groups=args.group_by??[];
 if(!Array.isArray(groups)||groups.length>1)return null;
 const group:unknown=groups[0];
 if(group!==undefined&&(typeof group!=="string"||!Object.hasOwn(columns,group)||!["label","local date","hour 0 to 23","weekday"].includes(columns[group].unit)||
      /(?:business_id|source_ref|status|source|employee|customer|email|phone)/i.test(group)))return null;
 if(group===undefined&&(!obj(r.aggregate)||r.aggregate.metric!==s.field||!["stored","so_far"].includes(String(r.aggregate.status))||r.rows.length!==1))return null;
 if(s.kind==="line"&&(typeof group!=="string"||columns[group].unit!=="local date"))return null;
 // Never imply disjoint parts of a whole for arbitrary grouped aggregates.
 if(s.kind==="donut")return null;
 const points:PresentationPanel["points"]=[];
 const filtered=Array.isArray(args.filters)&&args.filters.length>0;
 const title=(filtered?"Filtered: ":"")+m.fn.replaceAll("_"," ")+" "+m.column.replaceAll("_"," ");
 for(const row of r.rows){
   if(!obj(row)||!Object.hasOwn(row,s.field))return null;
   const value=row[s.field];
   const category=typeof group==="string"?row[group]:title;
   const label=typeof category==="number"&&typeof group==="string"&&["hour 0 to 23","weekday"].includes(columns[group].unit)?String(category):category;
   if(typeof label!=="string"||!label.trim()||label.length>140||
      typeof value!=="number"||!Number.isFinite(value))return null;
   if(typeof group==="string"&&columns[group].unit==="local date"&&
      (!z.iso.date().safeParse(label).success||label<r.period.from||label>r.period.to))return null;
   points.push({label,value});
 }
 if(new Set(points.map(x=>x.label)).size!==points.length)return null;
 if(s.kind==="line"){
   points.sort((a,b)=>a.label.localeCompare(b.label));
   if(points.length<2||points.some((p,i)=>i>0&&Date.parse(p.label)-Date.parse(points[i-1].label)!==86400000))return null;
 }
 return {kind:s.kind,title,unit:unit as PresentationPanel["unit"],currency:unit==="cents"||unit==="cents/hour"?ctx.currency??null:null,
   from:r.period.from,to:r.period.to,asOf:ctx.asOf,source:"canonical_data",
   sourceDetail:[view,s.field,filtered?queryScope(args,columns):"",columns[m.column].meaning,r.scopeWarning??"",...(partial?r.missing:[])].filter(Boolean).join(" · ").slice(0,500),
   ...(partial?{coverage:"partial" as const}:["processing_fee_cents","historical_recipe_cost_cents","historical_recipe_contribution_cents"].includes(m.column)?{coverage:"estimate" as const}:{}),points};
}
// A query's returned columns and aggregate aliases, not a new model-defined
// shape, determine the table. No new reads, raw JSON objects, identifiers,
// secret-bearing fields, inferred units, or client expressions.
// Admit only raw record paths with documented semantics and an exact type filter.
function rawFieldUnit(view:string,key:string,filters:unknown):string|undefined{
 if(view!=="cv_toast_records"||!Array.isArray(filters))return undefined;
 const types=filters.filter(f=>obj(f)&&f.column==="record_type"&&["=","in"].includes(String(f.op)));
 if(types.length!==1)return undefined;
 const f=types[0];if(!obj(f))return undefined;
 const values=f.op==="="? [f.value]:Array.isArray(f.value)?f.value:[];
 if(!values.length)return undefined;
 if(key==="data.name"&&values.every(v=>v==="item_discount"||v==="check_discount"))return "label";
 if(key==="data.display_name"&&values.every(v=>v==="employee"))return "label";
 if(key==="data.quantity"&&values.every(v=>v==="item"))return "items";
 return undefined;
}
function canonicalTable(r:AgentToolResult,encoded:string,ctx:Pick<AgentToolContext,"currency"|"asOf">):RecordTable|null{
 if(r.source!=="canonical_data"||r.error||r.empty||!r.period||!Array.isArray(r.rows)||r.rows.length===0)return null;
 let a:unknown;try{a=JSON.parse(encoded)}catch{return null}
 if(!obj(a)||typeof a.view!=="string"||!canonicalViewNames.includes(a.view as CanonicalView)||
  a.date_from!==r.period.from||a.date_to!==r.period.to)return null;
 const view=a.view as CanonicalView,fields=canonicalDictionary[view].columns as Record<string,{unit:string}>;
 const group=Array.isArray(a.group_by)?a.group_by:[],metrics=Array.isArray(a.metrics)?a.metrics:[],selected=Array.isArray(a.columns)?a.columns:[];
 // Explicitly selected columns only, never an implicit raw record dump.
 const keys:{key:string;label:string;unit:RecordTable["columns"][number]["unit"]}[]=[];
 const knownUnits=["label","local date","cents","count","items","units","quantity","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour","boolean","hour 0 to 23","weekday","timestamp text"] as const;
 const fieldUnit=(key:string)=>Object.hasOwn(fields,key)?fields[key].unit:rawFieldUnit(view,key,a.filters);
 const secret=/(?:business_id|source_ref|_ref$|(?:^|[._])id$|email|phone|password|token|secret|credential)/i;
 const add=(key:string,unit:string,label:string)=>{
  if(keys.some(c=>c.key===key))return;
  if(!knownUnits.includes(unit as typeof knownUnits[number])&&unit!=="stored")return;
  keys.push({key,label:label.slice(0,140),unit:unit as RecordTable["columns"][number]["unit"]});
 };
 for(const key of (group.length||metrics.length?group:selected)){
  if(typeof key!=="string"||secret.test(key)||key==="data")continue;
  const unit=fieldUnit(key);if(unit)add(key,unit,key.replaceAll("_"," "));
 }
 for(const m of metrics){
  if(!obj(m)||typeof m.column!=="string"||typeof m.fn!=="string"||!["sum","count","count_distinct","min","max","avg"].includes(m.fn))continue;
  const count=m.fn==="count"||m.fn==="count_distinct",unit=fieldUnit(m.column);
  if(!count&&(!unit||secret.test(m.column)||unit==="label"||unit==="local date"||unit==="stored"||unit==="boolean"))continue;
  if(!unit||m.column==="data")continue;
  add(m.fn+"_"+m.column,count?"count":unit,m.fn.replaceAll("_"," ")+" "+m.column.replaceAll("_"," "));
 }
 // Do not erase grouping dimensions and make distinct rows appear identical.
 if(group.some(key=>!keys.some(k=>k.key===key))||!keys.length||keys.length>8)return null;
 const rows=r.rows.slice(0,30).map(row=>obj(row)?keys.map(k=>{
  if(!Object.hasOwn(row,k.key))return undefined;
  const value=row[k.key];return value===null||typeof value==="string"||typeof value==="number"||typeof value==="boolean"?value:undefined;
 }):[]);
 if(rows.some(row=>row.some(v=>v===undefined)||row.length!==keys.length))return null;
 // Never hide filtering or completeness limits behind an attractive table.
 const filters=Array.isArray(a.filters)?a.filters.flatMap(f=>{
  if(!obj(f)||typeof f.column!=="string"||typeof f.op!=="string")return [];
  const safeValue=!secret.test(f.column)&&typeof fieldUnit(f.column)==="string"&&f.column!=="data";
  const shown=!safeValue?"selected value":Array.isArray(f.value)?f.value.map(x=>String(x)).join(", "):String(f.value??"");
  return [f.column+" "+f.op+" "+shown];
 }):[];
 const scope=["Selected safe fields only",filters.length?"Filtered: "+filters.join("; "):"Requested query",typeof r.scopeWarning==="string"?r.scopeWarning:"",...r.missing,keys.some(k=>/processing_fee_cents|historical_recipe_(?:cost|contribution)_cents/.test(k.key))?"Includes modeled costs or fees; not certified actual amounts.":""].filter(Boolean).join(" · ");
 const scopeText=scope.length>300?"Filtered query ("+filters.length+" filters); see the full answer for scope and limitations.":scope;
 const parsed=recordTableSchema.safeParse({title:"Saved query results",view,from:r.period.from,to:r.period.to,asOf:ctx.asOf,
  currency:keys.some(k=>k.unit==="cents"||k.unit==="cents/hour")?ctx.currency??null:null,
  coverage:r.missing.length||r.truncated||r.rows.length>30||r.scopeWarning||keys.some(k=>/processing_fee_cents|historical_recipe_(?:cost|contribution)_cents/.test(k.key))?"partial":"stored",
  scope:scopeText,columns:keys.map(({label,unit})=>({label,unit})),rows});
 return parsed.success?parsed.data:null;
}
function interactiveCalculation(r:AgentToolResult,encoded:string,ctx:Pick<AgentToolContext,"currency"|"asOf">):InteractiveCalc|null{
 if(r.source!=="calculate"||r.refused||r.missing.length||r.basedOnPartialData||!Array.isArray(r.inputs)||!Array.isArray(r.steps)||!obj(r.result))return null;
 let a:unknown;try{a=JSON.parse(encoded)}catch{return null}
 // Never edit screen metrics or stored facts. The owner can modify only an
 // explicit assumption they supplied in this read-only calculation.
 if(!obj(a)||a.screen_number!=="none"||typeof r.purpose!=="string"||!Array.isArray(a.inputs))return null;
 const originalInputs=a.inputs;
 // Rounded displays are not exact calculation operands. Fixed cents are
 // exact in the existing calculator; owner assumptions must reproduce the
 // exact submitted value at the local editor precision. Otherwise use prose.
 for(const input of r.inputs){
   if(!obj(input))return null;
   if(input.from!=="owner_said"){
     if(input.unit!=="cents"||!Number.isSafeInteger(input.valueCents))return null;
     continue;
   }
   const matches=originalInputs.filter(v=>obj(v)&&v.name===input.name);
   const original=matches[0];
   if(matches.length!==1||!obj(original)||original.owner_unit!==input.unit||typeof original.owner_value!=="number")return null;
   const v=original.owner_value;
   const displayed=input.unit==="cents"?input.valueCents:input.unit==="percent"&&typeof input.valueBps==="number"?input.valueBps/100:input.unit==="count"?input.quantity:undefined;
   if(v!==displayed||Math.abs(input.unit==="cents"?v/100:v)>=1_000_000_000||Number(v.toFixed(2))!==v)return null;
 }
 const shown=(value:Record<string,unknown>)=>value.unit==="cents"?{unit:value.unit,valueCents:value.valueCents}:
  value.unit==="percent"?{unit:value.unit,valueBps:value.valueBps}:value.unit==="count"?{unit:value.unit,quantity:value.quantity}:
  value.unit==="ratio"?{unit:value.unit,valueRatio:value.valueRatio}:null;
 const parsed=interactiveCalcSchema.safeParse({title:r.purpose,asOf:ctx.asOf,currency:ctx.currency??null,
  inputs:r.inputs.map(i=>obj(i)?{id:i.name,label:i.label,value:shown(i),editable:i.from==="owner_said"}:null),
  steps:r.steps.map(s=>obj(s)?{id:s.id,op:s.op,args:s.args}:null),original:shown(r.result)});
 if(!parsed.success)return null;
 // The persisted displayed inputs can be rounded. Do not offer a changed
 // calculator if the exact starting result cannot be reproduced.
 const reproduced=evaluatePresentationCalc(parsed.data);
 return reproduced&&JSON.stringify(reproduced)===JSON.stringify(parsed.data.original)?parsed.data:null;
}
function agendaFor(kind:NonNullable<z.infer<typeof presentationInputSchema>["agenda"]>,r:AgentToolResult,asOf:string):Agenda|null{
 const event=kind.endsWith("_events");
 if(!r.period||r.error||r.needsOwnerChoice||r.source!==(event?"cafe_events":"scheduled_shifts")||(!event&&r.scheduleSet!==true))return null;
 const selected=event?(r.selectedCityEventId?r.selectedCityEvent?[r.selectedCityEvent]:[]:r.events):r.shifts;
 if(!Array.isArray(selected)||!selected.length||selected.length>40)return null;
 const clock=(v:unknown)=>typeof v==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v)?v.slice(0,5):null;
 const entries:Agenda["entries"]=[];
 for(const row of selected){
   if(!obj(row))return null;
   const name=event?row.name:row.employeeName,day=event?row.startDate:row.date;
   if(typeof name!=="string"||typeof day!=="string"||!z.iso.date().safeParse(day).success)return null;
   const start=clock(event?row.startTime:row.start),end=clock(event?row.endTime:row.end);
   const endDate=event?row.endDate:typeof day==="string"&&start&&end&&end<start?
     new Date(Date.parse(day+"T12:00:00Z")+86400000).toISOString().slice(0,10):day;
   if(typeof endDate!=="string")return null;
   const parsed=event?(row.status==="cancelled"||row.status==="moved"?row.status:
     row.status==="found"&&typeof row.lastVerifiedAt==="string"&&z.iso.datetime({offset:true}).safeParse(row.lastVerifiedAt).success&&!row.verificationFailedAt?"found":"unverified"):row.source;
   if(parsed!=="found"&&parsed!=="cancelled"&&parsed!=="moved"&&parsed!=="unverified"&&parsed!=="app"&&parsed!=="toast"&&parsed!=="ai_draft")return null;
   entries.push({label:name,date:day,endDate,start,end,status:parsed,
     checkedAt:event&&typeof row.lastVerifiedAt==="string"&&z.iso.datetime({offset:true}).safeParse(row.lastVerifiedAt).success?row.lastVerifiedAt:null});
 }
 // These are saved listings/roster snapshots, not independent proof of current
 // attendance, event occurrence, permission, publication or staffing coverage.
 const partial=r.missing.length>0||Number(r.omittedEvents??0)>0||Number(r.omittedCityEvents??0)>0||
   entries.some(e=>e.status==="unverified"||e.status==="ai_draft");
 const out=agendaSchema.safeParse({kind:kind.startsWith("calendar")?"calendar":"timeline",source:event?"cafe_events":"scheduled_shifts",
   title:event?"Saved events":"Saved shift schedule",...r.period,asOf,coverage:partial?"partial":"saved",
   entries:entries.sort((a,b)=>a.date.localeCompare(b.date)||(a.start??"").localeCompare(b.start??""))});
 return out.success?out.data:null;
}
function modeledScenario(results:readonly AgentToolResult[],ctx:Pick<AgentToolContext,"asOf"|"currency"|"presentationScenarioBasis">,kind:NonNullable<z.infer<typeof presentationInputSchema>["scenario"]>,calls:readonly {name:string;arguments:string;result:AgentToolResult}[]):ScenarioComparison|null{
 const cases:ScenarioComparison["cases"]=[];
 const definitions={monthly_profit:["monthlyProfitCents","Modeled monthly profit"],monthly_break_even:["monthlyBreakEvenCents","Modeled monthly break-even"],monthly_target_sales:["monthlyTargetSalesCents","Modeled monthly target sales"],item_margin:["itemMarginCents","Modeled item margin"]} as const;
 const [field,title]=definitions[kind];
 const targets=new Set<string>();
 const money=(cents:unknown)=>typeof cents==="number"&&Number.isSafeInteger(cents)&&ctx.currency?
    new Intl.NumberFormat("en",{style:"currency",currency:ctx.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100):null;
 const targetName=(id:unknown,source:string,field:string)=>{
  if(typeof id!=="string")return null;
  const names=new Set(results.filter(r=>r.source===source&&!r.needsOwnerChoice).flatMap(r=>{
   const rows=r[field];if(!Array.isArray(rows))return [];
   return rows.flatMap(row=>obj(row)&&row.id===id&&typeof row.name==="string"?[row.name]:[]);
  }));
  return names.size===1?[...names][0]:null;
 };
 for(const r of results){
   if(r.source!=="scenario"||r.status!=="estimate"||r.provenance!=="estimate"||r.missing.length||
      !obj(r.input)||!obj(r.before)||!obj(r.after))continue;
   const i=r.input,before=r.before[field],after=r.after[field];
   if(typeof before!=="number"||typeof after!=="number"||!Number.isSafeInteger(before)||!Number.isSafeInteger(after))continue;
   let assumption:string|null=null,target:string|null=null;
   if(i.kind==="bill"&&typeof i.monthlyChangeCents==="number"&&Number.isSafeInteger(i.monthlyChangeCents)&&ctx.currency){
     assumption="Monthly bill change: "+new Intl.NumberFormat("en",{style:"currency",currency:ctx.currency,signDisplay:"always",minimumFractionDigits:2,maximumFractionDigits:2}).format(i.monthlyChangeCents/100);
   }else if(i.kind==="drinks"&&typeof i.changePercent==="number"&&Number.isFinite(i.changePercent)){
     assumption="Sales volume change: "+new Intl.NumberFormat("en",{style:"percent",signDisplay:"always",maximumFractionDigits:4}).format(i.changePercent/100);
   }else if(i.kind==="margin"&&typeof i.targetMargin==="number"&&Number.isFinite(i.targetMargin)&&kind==="monthly_target_sales"){
     assumption="Target margin: "+new Intl.NumberFormat("en",{style:"percent",maximumFractionDigits:4}).format(i.targetMargin);
   }else if(i.kind==="price"||i.kind==="item_cost"){
     const name=targetName(i.itemId,"menu_items","items");
     const old=money(i.kind==="price"?i.oldPriceCents:i.oldCostCents),next=money(i.kind==="price"?i.newPriceCents:i.newCostCents);
     if(name&&old&&next&&typeof i.weeklyUnits==="number"&&Number.isFinite(i.weeklyUnits)){
       target="item:"+String(i.itemId);
       assumption=name+" · "+(i.kind==="price"?"Price":"Ingredient cost")+": "+old+" → "+next+" · "+i.weeklyUnits+" units/week";
     }
   }else if(i.kind==="shift"||i.kind==="wage"){
     // The simulator validates the exact employee. Reuse its executed call
     // and prior exact roster label, never a guessed identity or raw ID.
     const call=calls.find(x=>x.name==="simulate_scenario"&&x.result===r);
     let input:unknown=null;try{if(call)input=JSON.parse(call.arguments)}catch{/* no qualified identity */}
     if(obj(input)){
       const name=targetName(input.staffId,"employees+scheduled_shifts","people");
       if(name){
         target="staff:"+String(input.staffId);
         if(i.kind==="shift"&&typeof i.hoursChange==="number"&&typeof i.shiftsPerWeek==="number"){
           assumption=name+" · "+i.hoursChange+" hours/shift × "+i.shiftsPerWeek+" shifts/week";
         }else if(i.kind==="wage"){
           const old=money(i.oldWageCents),next=money(i.newWageCents);
           if(old&&next)assumption=name+" · Hourly wage: "+old+" → "+next;
         }
       }
     }
   }
   if(assumption!==null&&assumption.length<=140){const seed=ctx.presentationScenarioBasis?.get(r);
     const ed=seed?scenarioEditorSchema.safeParse({...seed,metric:field}):null;
     const baseline=ed?.success?evaluateScenarioEditor(ed.data):null;
     const editor=ed?.success&&baseline?.beforeCents===before&&baseline.afterCents===after?ed.data:undefined;
     cases.push({assumption,beforeCents:before,afterCents:after,...(editor?{editor}:{})});if(target)targets.add(target);}
 }
 const unique=[...new Map(cases.map(c=>[JSON.stringify(c),c])).values()];
 if(targets.size>1||new Set(unique.map(c=>c.beforeCents)).size!==1||new Set(unique.map(c=>c.assumption)).size!==unique.length)return null;
 const out=scenarioComparisonSchema.safeParse({title,currency:ctx.currency,asOf:ctx.asOf,provenance:"estimate",cases:unique});
 return out.success?out.data:null;
}
/** Project named fields from existing typed readers, not arbitrary JSON paths. */
function readerTable(r:AgentToolResult,ctx:Pick<AgentToolContext,"currency"|"asOf">):RecordTable|null{
 if(r.error||r.needsOwnerChoice)return null;
 const columns:RecordTable["columns"]=[];
 let rows:RecordTable["rows"]=[],title="",scope="",currency:string|null=null;
 const text=(v:unknown)=>typeof v==="string"?v:null;
 const num=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
 const bool=(v:unknown)=>typeof v==="boolean"?v:null;
 const date=(v:unknown)=>typeof v==="string"&&z.iso.date().safeParse(v).success?v:null;
 const add=(label:string,unit:RecordTable["columns"][number]["unit"])=>columns.push({label,unit});
 const from=r.period?.from??ctx.asOf,to=r.period?.to??ctx.asOf;
 if(r.source==="supplier_purchase_plan"&&Array.isArray(r.offers)&&r.sourceTrust==="owner_reported"&&r.comparison==="subtotal_only"){
   if(!ctx.currency||r.offers.some(o=>!obj(o)||o.currency!==ctx.currency||typeof o.supplierName!=="string"||typeof o.subtotalCents!=="number"||!Number.isSafeInteger(o.subtotalCents)))return null;
   title="Supplier quote subtotals";scope="Saved owner-reported quotes for requested quantities. Excludes unknown freight and tax; not landed cost or delivery confirmation.";
   currency=ctx.currency;add("Supplier","label");add("Subtotal","cents");add("Shipping","cents");add("Tax","cents");
   rows=r.offers.map(o=>[o.supplierName,o.subtotalCents,null,null]);
 }else if(r.source==="purchase_orders"&&Array.isArray(r.orders)){
   if(!ctx.currency||r.orders.some(o=>!obj(o)||o.currency!==ctx.currency))return null;
   title="Saved purchase orders";scope="Saved order history as of snapshot. Internal approval does not mean sent or received; no payment inference.";
   currency=ctx.currency;add("Supplier","label");add("Status","label");add("Subtotal","cents");add("Needed by","local date");add("Approved at","timestamp text");add("Sent","boolean");add("Received into inventory","boolean");
   rows=r.orders.map(o=>[text(o.supplierName),text(o.status),num(o.subtotalCents),date(o.neededBy),text(o.approvedAt),bool(o.sentToSupplier),bool(o.receivedIntoInventory)]);
 }else if(r.source==="inventory"&&Array.isArray(r.inventory)&&r.scope==="observed_inventory_only"){
   title="Observed inventory";scope="Saved counts and retained evidence only. Unnamed records and unknown quantities are not zero; units may differ.";
   add("Item","label");add("Quantity","quantity");add("Unit","label");add("Evidence state","label");add("Source as of","timestamp text");
   rows=r.inventory.flatMap(o=>{
    if(!obj(o)||!["observed_current","dated_owner_count","not_observed","source_failed","source_unverified"].includes(String(o.evidence_state)))return [];
    const known=["observed_current","dated_owner_count"].includes(String(o.evidence_state))&&o.quantity_state==="known";
    return [[text(o.ingredient_name)??"Unnamed stock record",known?num(o.quantity):null,text(o.quantity_unit),text(o.evidence_state),text(o.source_as_of)]];
   });
 }else if(r.source==="menu_items"&&Array.isArray(r.items)){
   if(!ctx.currency)return null;
   title="Saved menu price records";scope="Catalog prices, not realized selling prices. Open prices and unavailable values remain unknown.";
   currency=ctx.currency;add("Item","label");add("Category","label");add("Catalog price","cents");add("Price evidence","label");
   rows=r.items.flatMap(o=>obj(o)&&typeof o.name==="string"?[[o.name,text(o.category),o.priceStatus==="fixed"?num(o.priceCents):null,text(o.priceSource)]]:[]);
 }else return null;
 if(!rows.length)return null;
 const parsed=recordTableSchema.safeParse({title,view:"tool_"+r.source,from,to,asOf:ctx.asOf,currency,
  coverage:r.missing.length||r.source==="supplier_purchase_plan"||r.source==="inventory"||rows.length>30?"partial":"stored",
  scope,columns,rows:rows.slice(0,30)});
 return parsed.success?parsed.data:null;
}
function supplierPanel(s:z.infer<typeof selection>,r:AgentToolResult,ctx:Pick<AgentToolContext,"currency"|"asOf">):PresentationPanel|null{
 if(s.source!=="supplier_purchase_plan"||s.field!=="subtotal"||s.kind==="line"||s.kind==="donut")return null;
 const table=readerTable(r,ctx);
 if(!table||!table.currency||!table.rows.every(row=>typeof row[0]==="string"&&typeof row[1]==="number"))return null;
 const points=table.rows.map(row=>({label:row[0] as string,value:row[1] as number}));
 if(new Set(points.map(p=>p.label)).size!==points.length)return null;
 return {kind:s.kind,title:table.title,unit:"cents",currency:table.currency,from:table.from,to:table.to,asOf:table.asOf,source:"supplier_purchase_plan",sourceDetail:table.scope,coverage:"partial",points};
}
function costPanel(s:z.infer<typeof selection>,r:AgentToolResult,ctx:Pick<AgentToolContext,"asOf"|"currency">):PresentationPanel|null{
 if(r.source!==s.source||r.error||r.missing.length||r.needsOwnerChoice||!ctx.currency||s.kind==="line")return null;
 let points:PresentationPanel["points"]=[],title="";
 const from=r.period?.from??ctx.asOf,to=r.period?.to??ctx.asOf;
 if(s.source==="expenses"&&s.field==="recorded_expenses"){
   // Category amounts may be estimates or include recurring accruals. Only
   // the exact recorded actual total is admitted by this presentation.
   if(typeof r.recordedActualTotalCents!=="number"||s.kind==="donut")return null;
   title="Recorded expenses";points=[{label:title,value:r.recordedActualTotalCents}];
 }else if(s.source==="business_costs"&&s.field==="cost_components"){
   if(r.completeness!=="complete"||!Array.isArray(r.estimated)||r.estimated.length||!obj(r.components))return null;
   title="Recorded business costs";
   const components=[["ingredientsCents","Ingredients"],["loadedStaffCents","Staff"],["cardFeesCents","Card fees"],["runningCostsCents","Running costs"]] as const;
   for(const [key,label] of components){
     const value=r.components[key];if(typeof value!=="number"||!Number.isSafeInteger(value))return null;
     points.push({label,value});
   }
 }else if(s.source==="product_costs"&&s.field==="recipe_cost"&&obj(r.item)&&r.item.costStatus==="READY"&&
    typeof r.item.ingredientsCentsToday==="number"&&typeof r.item.name==="string"&&s.kind!=="donut"){
   // Cost estimate provenance varies by recipe. Use only server-certified
   // recorded totals here; the regular answer retains other estimate cases.
   if(r.item.costSource!=="recipe"||r.item.costQuality!=="recorded")return null;
   title="Ingredient cost per item";points=[{label:r.item.name,value:r.item.ingredientsCentsToday}];
 }else return null;
 return {kind:s.kind,title,unit:"cents",currency:ctx.currency,from,to,asOf:ctx.asOf,source:s.source,points};
}
function project(s:z.infer<typeof selection>,r:AgentToolResult,ctx:Pick<AgentToolContext,"currency"|"asOf">):PresentationPanel|null {
 if(s.source==="supplier_purchase_plan")return supplierPanel(s,r,ctx);
 if(s.source==="expenses"||s.source==="business_costs"||s.source==="product_costs")return costPanel(s,r,ctx);
 const d=Object.hasOwn(descriptions,s.field)?descriptions[s.field as keyof typeof descriptions]:null;
 if(!d||d.source!==s.source||r.source!==s.source||r.missing.length||r.needsOwnerChoice||
   r.provisional||r.coverageFallback||r.selectedMoneySource==="ownerProvided"||
   !r.period||r.period.to>ctx.asOf)return null;
 if(s.source==="profitability"&&(r.estimated===undefined||!Array.isArray(r.estimated)||r.estimated.length))return null;
 let points:PresentationPanel["points"]=[];
 let {from,to}=r.period;
 if(s.field==="daily_sales"||s.field==="item_units"){
   const rows=s.field==="daily_sales"?r.days:r.items;
   if(!Array.isArray(rows)||!rows.length||rows.length>30)return null;
   for(const row of rows){
     if(!obj(row))return null;
     const label=s.field==="daily_sales"?row.date:row.name;
     const value=s.field==="daily_sales"?row.netSalesCents:row.units;
     if(row.provisional===true||typeof label!=="string"||!label.trim()||label.length>140||
        typeof value!=="number"||!Number.isSafeInteger(value)||(s.field==="item_units"&&value<0))return null;
     if(s.field==="daily_sales"&&(!z.iso.date().safeParse(label).success||label<from||label>to))return null;
     points.push({label,value});
   }
   if(s.field==="daily_sales"){
     points.sort((a,b)=>a.label.localeCompare(b.label));
     if(new Set(points.map(p=>p.label)).size!==points.length)return null;
     from=points[0].label;to=points[points.length-1].label;
   }
 }else{
   const key=s.field==="net_sales"?"netSalesCents":s.field==="total_costs"?"totalCostsCents":"ownerProfitCents";
   const value=r[key];
   if(typeof value!=="number"||!Number.isSafeInteger(value))return null;
   points=[{label:d.title,value}];
 }
 if(s.kind==="line"&&(s.field!=="daily_sales"||points.length<2||points.some((p,i)=>i>0&&Date.parse(p.label)-Date.parse(points[i-1].label)!==86400000)))return null;
 // A series of daily values is not a part-to-whole; a donut may only display item units.
 if(s.kind==="donut"&&(s.field!=="item_units"||typeof r.itemCount!=="number"||r.itemCount!==points.length))return null;
 return {kind:s.kind,title:d.title,unit:d.unit,currency:d.unit==="cents"?ctx.currency??null:null,
   from,to,asOf:ctx.asOf,source:s.source,points};
}
export function presentResponse(raw:unknown,ctx:Pick<AgentToolContext,"currency"|"asOf"|"turnResults|"presentationResults"|"presentationAttachments"|"presentationScenarioBasis">):AgentToolResult{
 const empty={source:"response_presentation",period:null,missing:[]};
 const parsed=presentationInputSchema.safeParse(raw);
 if(!parsed.success||!ctx.turnResults)return {...empty,accepted:false};
 const results=ctx.turnResults();
 const canonical=ctx.presentationResults?.()??[];
 const tables:RecordTable[]=[];
 const slots=new Map<string,string>();
 let panelIndex=0;
 const panels=parsed.data.panels.flatMap((s,i)=>{
   const selected= s.ref?canonical.filter(x=>x.ref===s.ref):canonical;
   if(s.ref&&selected.length!==1)return [];
   const matching=(r:AgentToolResult)=>r.source===s.source&&(!s.from||r.period?.from===s.from)&&(!s.to||r.period?.to===s.to);
   if(s.kind==="table"&&s.field==="rows"){
     const candidates=s.source==="canonical_data"?selected.filter(x=>x.name==="query_data"&&matching(x.result)).flatMap(x=>{
       const table=canonicalTable(x.result,x.arguments,ctx);return table?[table]:[];
     }):(s.ref?selected:results).filter(x=>matching(x.result)).flatMap(x=>{const table=readerTable(x.result,ctx);return table?[table]:[]});
     const distinct=[...new Map(candidates.map(t=>[JSON.stringify(t),t])).values()];
     if(distinct.length===1&&tables.length<2){slots.set("p"+i,"table"+tables.length);tables.push(distinct[0]);}
     return [];
   }
   const candidates=s.source==="canonical_data"?selected.filter(x=>x.name==="query_data"&&matching(x.result)).flatMap(x=>{
     const p=canonicalPanel(s,x.result,x.arguments,ctx);return p?[p]:[];
   }):(s.ref?selected:results).filter(x=>matching(x.result)).flatMap(x=>{const p=project(s,x.result,ctx);return p?[p]:[]});
   // Repeated identical reads can collapse; never silently pick a distinct period or subtotal.
   const distinct=[...new Map(candidates.map(p=>[JSON.stringify(p),p])).values()];
   const p=distinct.length===1?distinct[0]:null;
   if(p?.kind==="ranked_table")p.points.sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));
   const checked=p&&richPresentationSchema.safeParse({type:"rich_presentation",version:1,layout:"stack",panels:[p],suggestions:[]});
   if(checked&&checked.success){slots.set("p"+i,"panel"+panelIndex++);return checked.data.panels;}
   return [];
 });
 const agendaCandidates=parsed.data.agenda?results.flatMap(({result})=>{
   const a=agendaFor(parsed.data.agenda!,result,ctx.asOf);return a?[a]:[];
 }):[];
 const agendas=[...new Map(agendaCandidates.map(a=>[JSON.stringify(a),a])).values()];
 const scenario=parsed.data.scenario?modeledScenario(results.map(x=>x.result),ctx,parsed.data.scenario,canonical):null;
 const calculators=parsed.data.calculator?canonical.filter(x=>x.name==="calculate").flatMap(x=>{
  const c=interactiveCalculation(x.result,x.arguments,ctx);return c?[c]:[];
 }):[];
 const uniqueCalcs=[...new Map(calculators.map(c=>[JSON.stringify(c),c])).values()];
 const files=parsed.data.files?[...new Set(ctx.presentationAttachments??[])].filter(id=>z.uuid().safeParse(id).success).slice(0,3):[];
 const block=richPresentationSchema.safeParse({type:"rich_presentation",version:1,
   layout:parsed.data.layout,panels,...(files.length?{files}:{}),...(tables.length?{tables}:{}),...(uniqueCalcs.length===1?{calculator:uniqueCalcs[0]}:{}),...(parsed.data.report?{report:true as const}:{}),...(agendas.length===1?{agenda:agendas[0]}:{}),...(scenario?{scenario}:{}),suggestions:[...new Set(parsed.data.suggestions)]});
 if(!block.success)return {...empty,accepted:false};
 if(!parsed.data.groups?.length)return {...empty,accepted:true,presentation:block.data};
 const leaves=presentationLeaves(block.data),used=new Set<string>();
 const groups:NonNullable<RichPresentation["groups"]>=[];
 for(const request of parsed.data.groups){
   const items=request.items.flatMap(id=>{
     const key=slots.get(id)??id;
     if(!leaves.includes(key)||used.has(key))return [];
     used.add(key);return [key];
   });
   if(items.length)groups.push({layout:request.layout==="compare"&&!compatibleComparison(items,block.data.panels)?"grid":request.layout,items});
 }
 const remainder=leaves.filter(k=>!used.has(k));
 if(remainder.length)groups.push({layout:parsed.data.layout,items:remainder});
 const arranged=richPresentationSchema.safeParse({...block.data,...(groups.length?{groups}:{})});
 return {...empty,accepted:true,presentation:arranged.success?arranged.data:block.data};
}
export const presentationTools={
 present_response:{schema:presentationInputSchema,description:"Optional UI from current reads, never invented data. Source+field: daily_rollups daily_sales; item_sales item_units; profitability net_sales/total_costs/owner_profit; canonical_data exact aggregate alias or field rows for a multi-column table; expenses recorded_expenses; business_costs cost_components; product_costs recipe_cost; supplier_purchase_plan subtotal/rows; purchase_orders, inventory, menu_items rows. Use ref from the prior result to disambiguate; groups arrange p0–p3, agenda/scenario/calculator in stack/grid/compare (same units). Agenda from get_events/get_week_schedule; scenario monthly_profit/monthly_break_even/monthly_target_sales/item_margin from verified simulate_scenario; calculator=true after calculate for editable owner assumptions (not screen numbers); report=true for text export; files=true for sources attached in this turn only. Suggestions edit a draft, never act. Answer fully in words; visuals only if useful."},
};
