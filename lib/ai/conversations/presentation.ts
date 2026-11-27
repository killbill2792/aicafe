import {scenarioEditorSchema,evaluateScenarioEditor} from "./scenarioPresentation";
import { z } from "zod";
import {adaptDisplayValue} from "./displayPropCompatibility";
import {nativeSpecSchema,nativeFunctions,readNativeSnapshot,recoverNativeDisplaySpec,safeNativeJSON} from "./nativePresentation";
import {resolveElementProps,splitRepeatVisibility,evaluateVisibility,getByPath,resolveRepeatStatePath,resolveRepeatItemStatePath,type PropResolutionContext,type Spec} from "@json-render/core";
import {exactDecimal,exactNumber,runCalculation,CALC_OPS,type CalcOp,type CalcShown} from "@/lib/metrics/core/calculator";

/** Versioned, renderer-independent, serializable UI. No client code or action bindings. */
const label=z.string().min(1);
const date=z.iso.date();
/** One source enumeration for the stored contract, model selection and wire references. */
export const presentationSourceNames=["daily_rollups","item_sales","profitability","canonical_data","expenses","business_costs","product_costs","supplier_purchase_plan","purchase_orders","inventory","menu_items","labor_and_attendance","get_peak_hours","get_employee_sales","get_payroll_facts","today_live","usage_variance","ingredient_prices","recurring_bills","break_even","pricing_engine","new_item_price","milk_swap","cashflow_evidence","current_staff","goals","locations.open_hours","scheduled_shifts+locations.open_hours","employees+shiftCost","olivia_schedule","olivia_owner_what_if","olivia_hypothetical_absence"] as const;
const point=z.strictObject({label,value:z.number().finite()});
export const presentationPanelSchema=z.strictObject({
  kind:z.enum(["metric","table","ranked_table","bar","line","donut"]),
  title:label,unit:z.enum(["cents","count","items","units","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour"]),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
  from:date,to:date,asOf:date,source:z.enum([...presentationSourceNames,"sql_research","response_evidence"] as const),
  sourceDetail:z.string().optional(),measurement:z.string().trim().min(1).optional(),
  coverage:z.enum(["partial","estimate","unverified"]).optional(),
  points:z.array(point).min(1),
}).superRefine((p,ctx)=>{
  if(p.from>p.to)
    ctx.addIssue({code:"custom",message:"Invalid presentation period"});
});
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const agendaSchema=z.strictObject({
 kind:z.enum(["calendar","timeline"]),source:z.enum(["cafe_events","scheduled_shifts"]),
 title:label,from:date,to:date,asOf:date,coverage:z.enum(["saved","partial"]),
 entries:z.array(z.strictObject({label,date,endDate:date,start:clock.nullable(),end:clock.nullable(),
   status:z.enum(["found","cancelled","moved","unverified","app","toast","ai_draft"]),
   checkedAt:z.iso.datetime({offset:true}).nullable(),endUnknown:z.literal(true).optional()})).min(1),
}).refine(a=>a.from<=a.to&&a.entries.every(e=>e.date<=e.endDate&&e.date<=a.to&&e.endDate>=a.from&&(!e.endUnknown||(e.date===e.endDate&&e.end===null))));
export const scenarioComparisonSchema=z.strictObject({
 title:label,currency:z.string().regex(/^[A-Z]{3}$/),asOf:date,
 provenance:z.literal("estimate"),
 cases:z.array(z.strictObject({assumption:label,beforeCents:z.number().int().safe(),afterCents:z.number().int().safe(),editor:scenarioEditorSchema.optional()}).refine(c=>{
   if(!c.editor)return true;
   const original=evaluateScenarioEditor(c.editor);
   return original?.beforeCents===c.beforeCents&&original.afterCents===c.afterCents;
 })).min(1)
});
const tableUnit=z.enum(["label","local date","microcents","cents","count","items","units","quantity","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour","boolean","hour 0 to 23","weekday","timestamp text","stored"]);
const cell=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
export const recordTableSchema=z.strictObject({
 title:label,view:z.string().regex(/^(?:cv|tool)_[a-z_]+$/).max(80),from:date,to:date,asOf:date,
 currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 coverage:z.enum(["stored","partial","estimate","unverified","authored"]),scope:z.string(),
 columns:z.array(z.strictObject({label,unit:tableUnit})).min(1),
 rows:z.array(z.array(cell).min(1)).min(1),
}).superRefine((t,ctx)=>{
 if(t.from>t.to||t.rows.some(r=>r.length!==t.columns.length))ctx.addIssue({code:"custom",message:"Invalid table shape"});
});
const calcName=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
const calcShown=z.discriminatedUnion("unit",[
 z.strictObject({unit:z.literal("cents"),valueCents:z.number().int().safe()}),
 z.strictObject({unit:z.literal("percent"),valueBps:z.number().int().safe()}),
 z.strictObject({unit:z.literal("count"),quantity:z.number().finite()}),
 z.strictObject({unit:z.literal("ratio"),valueRatio:z.number().finite()}),
]);
export const interactiveCalcSchema=z.strictObject({
 title:label,asOf:date,currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 inputs:z.array(z.strictObject({id:calcName,label,value:calcShown,editable:z.boolean()})).min(1),
 steps:z.array(z.strictObject({id:calcName,op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),args:z.array(calcName).min(1)})).min(1),
 original:calcShown,
}).refine(c=>new Set(c.inputs.map(i=>i.id)).size===c.inputs.length);
export type RecordTable=z.infer<typeof recordTableSchema>;
export type InteractiveCalc=z.infer<typeof interactiveCalcSchema>;
/** Reuse the one exact arithmetic engine. Local values are hypothetical, never
 * written to the business or attached to an approval or trusted output. */
export function evaluatePresentationCalc(c:InteractiveCalc,changes:Readonly<Record<string,string>>={}):CalcShown|null{
 const entries=new Map<string,NonNullable<ReturnType<typeof exactNumber>>>();
 for(const input of c.inputs){
  const v=input.value;
  const n=v.unit==="cents"?v.valueCents:v.unit==="percent"?v.valueBps:v.unit==="count"?v.quantity:v.valueRatio;
  if(input.editable&&Object.hasOwn(changes,input.id)){
   const raw=changes[input.id].trim();
   const entered=exactDecimal(raw,v.unit,v.unit==="percent"?100:1);
   if(!entered)return null;
   // Currency inputs are displayed in major units; arithmetic uses minor units.
   entries.set(input.id,v.unit==="cents"?{...entered,n:entered.n*BigInt(100)}:entered);
   continue;
  }
  const value=exactNumber(n,v.unit,v.unit==="percent"?10000:1);
  if(!value)return null;
  entries.set(input.id,value);
 }
 const outcome=runCalculation(entries,c.steps);
 return outcome.ok?outcome.result.shown:null;
}
/** A bounded semantic grouping grammar, independent of the renderer. Leaf
 * references identify only already validated snapshot components. */
/** Preserve authored headings, including numeric or estimated claims. */
export function descriptiveGroupTitle(value:string|null|undefined):string|undefined{
 if(!value?.trim())return undefined;
 return value;
}
// Flat reference graph supports recursive layouts without accepting recursive
// model-authored JSON, executable props, repeated leaves or unbounded trees.
export const presentationGroupSchema=z.strictObject({id:z.string().regex(/^g\d+$/).optional(),layout:z.enum(["stack","grid","compare","details"]),title:label.optional(),items:z.array(z.string().regex(/^(?:panel\d+|table\d+|agenda|scenario|calculator|files|report|suggestions|g\d+)$/)).min(1)});
type PresentationGroup=z.infer<typeof presentationGroupSchema>;
export function presentationGroupRoots(groups:readonly PresentationGroup[]):number[]{
 const children=new Set(groups.flatMap(g=>g.items));
 return groups.flatMap((g,i)=>!g.id||!children.has(g.id)?[i]:[]);
}
/** Validate topology before rendering: each owned data leaf exactly once; acyclic nesting has no fixed depth. */
export function validPresentationGroups(groups:readonly PresentationGroup[],leaves:readonly string[],panels:PresentationPanel[]):boolean{
 const ids=new Map<string,number>();
 for(let i=0;i<groups.length;i++){const id=groups[i].id;if(id){if(ids.has(id))return false;ids.set(id,i);}}
 const seenGroups=new Set<number>(),seenLeaves=new Set<string>(),pending=presentationGroupRoots(groups);
 while(pending.length){
  const i=pending.pop()!;if(seenGroups.has(i))return false;
  seenGroups.add(i);const g=groups[i];
  if(g.layout==="details"&&!g.title||g.layout==="compare"&&!compatibleComparison(g.items,panels))return false;
  for(const key of g.items){const child=ids.get(key);if(child!==undefined)pending.push(child);else{if(!leaves.includes(key)||seenLeaves.has(key))return false;seenLeaves.add(key);}}
 }
 return seenGroups.size===groups.length&&seenLeaves.size===leaves.length;
}
const richPresentationBaseSchema=z.strictObject({
  type:z.literal("rich_presentation"),version:z.literal(1),
  layout:z.enum(["stack","grid"]),
  panels:z.array(presentationPanelSchema),
  nativeSpec:nativeSpecSchema.optional(),
  // Persist authored document data, not an executable or remotely hosted file.
  pdfSpec:z.record(z.string(),z.unknown()).refine(safeNativeJSON).optional(),
  groups:z.array(presentationGroupSchema).min(1).optional(),
  report:z.literal(true).optional(),
  files:z.array(z.uuid()).min(1).max(3).refine(ids=>new Set(ids).size===ids.length).optional(),
  tables:z.array(recordTableSchema).optional(),
  calculator:interactiveCalcSchema.optional(),
  agenda:agendaSchema.optional(),
  scenario:scenarioComparisonSchema.optional(),
  suggestions:z.array(z.string().trim().min(1)),
});
// Infer the snapshot type from the structural fields before applying graph
// refinements, which themselves consume that type. Avoid circular inference.
export type RichPresentation=z.infer<typeof richPresentationBaseSchema>;
export const richPresentationSchema=richPresentationBaseSchema.refine(p=>Number(Boolean(p.nativeSpec))+Number(Boolean(p.pdfSpec))+p.panels.length+p.suggestions.length+Number(Boolean(p.agenda))+Number(Boolean(p.scenario))+Number(Boolean(p.report))+Number(Boolean(p.calculator))+(p.tables?.length??0)+(p.files?.length??0)>0).refine(p=>{
 if(!p.groups)return true;
 return validPresentationGroups(p.groups,p.groups.some(g=>g.id)?allPresentationLeaves(p):presentationLeaves(p),p.panels);
});
export type PresentationPanel=z.infer<typeof presentationPanelSchema>;
export function presentationLeaves(p:Pick<RichPresentation,"panels"|"tables"|"agenda"|"scenario"|"calculator">):string[]{
 return [...p.panels.map((_,i)=>"panel"+i),...(p.agenda?["agenda"]:[]),...(p.scenario?["scenario"]:[]),...(p.tables??[]).map((_,i)=>"table"+i),...(p.calculator?["calculator"]:[])];
}
/** Both data visuals and safe local interactions are composable. Legacy unnamed groups retain their historic trailing controls. */
export function allPresentationLeaves(p:RichPresentation):string[]{
 return [...presentationLeaves(p),...(p.files?.length?["files"]:[]),...(p.report?["report"]:[]),...(p.suggestions.length?["suggestions"]:[])];
}
export function compatibleComparison(items:string[],panels:PresentationPanel[]):boolean{
 if(items.length<2||items.some(k=>!/^panel\d+$/.test(k)))return false;
 const series=items.map(k=>panels[Number(k.slice(5))]);
 if(series.some(p=>!p||p.kind==="donut"))return false;
 const first=series[0];
 // Exact matching categories or a shared daily axis. Never align unrelated
 // labels, or mix incompatible measurement units/currencies on one axis.
 return new Set(series.map(p=>[p.title,p.from,p.to,p.sourceDetail??p.source].join("|"))).size===series.length&&series.every(p=>p.unit===first.unit&&p.currency===first.currency&&p.measurement===first.measurement)&&
  (series.every(p=>p.points.length===1)||series.every(p=>p.points.length===first.points.length&&p.points.every((v,i)=>v.label===first.points[i].label))||
   series.every(p=>p.kind==="line"&&p.points.every(v=>date.safeParse(v.label).success)));
}

export type Agenda=z.infer<typeof agendaSchema>;
export type ScenarioComparison=z.infer<typeof scenarioComparisonSchema>;

/** Text export is a snapshot of the already loaded message, never a new
 * server report, model request, signed URL, file reader or action. Keep numeric
 * caveats attached to their original spans, including legacy storage chunks. */
export function presentationReport(block:RichPresentation,message:{
 blocks:unknown[]|null;grounding:Record<string,unknown>|null;createdAt:string
}):string{
 const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
 const texts=(message.blocks??[]).map(b=>object(b)&&(b.type==="text"||b.type==="warning")&&typeof b.text==="string"?b.text:null);
 const metadata=message.grounding?.agentMetadata;
 const raw=object(metadata)&&Array.isArray(metadata.unverified)?metadata.unverified:[];
 const notes=raw.flatMap(s=>{
   if(!object(s)||typeof s.blockIndex!=="number"||typeof s.start!=="number"||typeof s.end!=="number"||
      ![s.blockIndex,s.start,s.end].every(Number.isSafeInteger))return [];
   const text=texts[s.blockIndex];
   if(typeof text!=="string"||s.start<0||s.end<=s.start||s.end>text.length)return [];
   return [text.slice(s.start,s.end)+" — "+(s.source==="owner"?"Owner supplied":s.source==="estimate"?"Estimate":"Unverified")];
 });
 const lines=["Supervisor — saved answer export","Saved: "+message.createdAt,
  "Answer status: "+(typeof message.grounding?.status==="string"?message.grounding.status:"Not recorded"),
  "",texts.filter((t):t is string=>t!==null).join(""),
  ...(notes.length?["","Source cautions",...notes]:[])];
 lines.push(...presentationDataLines(block));
 lines.push("","Export only. Refer to the original conversation for approvals, work status and current information.");
 return lines.join("\n");
}

/** Café-local civil-date page. The existing source dates are never converted
 * into a guessed café timezone. Include every day of multi-day records. */
export function calendarPage(agenda:Agenda,offset:number){
 const from=Date.parse(agenda.from),to=Date.parse(agenda.to),day=86400000;
 const count=Math.floor((to-from)/day)+1,pages=Math.max(1,Math.ceil(count/28));
 const page=Math.min(pages-1,Math.max(0,offset));
 return {page,pages,days:Array.from({length:Math.min(28,count-page*28)},(_,i)=>{
  const date=new Date(from+(page*28+i)*day).toISOString().slice(0,10);
  return {date,weekday:new Date(date).getUTCDay(),entries:agenda.entries.filter(e=>e.date<=date&&e.endDate>=date)};
 })};
}

/** Repair presentation layout, not business facts. Invalid siblings or layout
 * graphs must not hide independently renderable, data-only components. */
export function recoverRichPresentation(raw:unknown):RichPresentation|undefined{
 const exact=richPresentationSchema.safeParse(raw);if(exact.success)return exact.data;
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return;
 const r=raw as Record<string,unknown>;
 if(r.type!=="rich_presentation"||r.version!==1)return;
 const valid=<T>(schema:z.ZodType<T>,value:unknown):T|undefined=>{const v=schema.safeParse(adaptDisplayValue(schema,value));return v.success?v.data:undefined;};
 const list=<T>(schema:z.ZodType<T>,value:unknown):T[]=>Array.isArray(value)?value.flatMap(v=>{const p=valid(schema,v);return p===undefined?[]:[p];}):[];
 // Retain a leaf whose real renderer cannot consume it, even when valid
 // siblings exist. The fallback is inert; it cannot acquire actions.
 const unresolved:unknown[]=[];
 const leaf=<T>(schema:z.ZodType<T>,value:unknown):T|undefined=>{
  if(value===undefined)return undefined;
  const result=valid(schema,value);
  if(result===undefined)unresolved.push(value);
  return result;
 };
 const leaves=<T>(schema:z.ZodType<T>,value:unknown):T[]=>Array.isArray(value)?value.flatMap(v=>{const p=leaf(schema,v);return p===undefined?[]:[p];}):value===undefined?[]:(unresolved.push(value),[]);
 const panels=leaves(presentationPanelSchema,r.panels),tables=leaves(recordTableSchema,r.tables);
 const agenda=leaf(agendaSchema,r.agenda),scenario=leaf(scenarioComparisonSchema,r.scenario),calculator=leaf(interactiveCalcSchema,r.calculator);
 let native=valid(nativeSpecSchema,r.nativeSpec)??recoverNativeDisplaySpec(r.nativeSpec);
 if(r.nativeSpec!==undefined&&!native)unresolved.push(r.nativeSpec);
 if(unresolved.length){
  const elements:Spec["elements"]={...native?.elements};
  const keyFor=(base:string)=>{let key=base;while(Object.hasOwn(elements,key))key+="_";return key;};
  const children=native?[native.root]:[];
  for(const value of unresolved){
   const key=keyFor("authored");
   // Never evaluate invalid expressions or unsafe paths in fallback content.
   const data=safeNativeJSON(value)?value:JSON.stringify(value)??String(value);
   elements[key]={type:"LunaFallback",props:{widget:"Authored content",values:data},children:[]};
   children.push(key);
  }
  const root=keyFor("recovered");
  elements[root]={type:"Stack",props:{},children};
  native={root,elements,...(native?.state?{state:native.state}:{})};
 }
 const repaired=richPresentationSchema.safeParse({type:"rich_presentation",version:1,layout:r.layout==="grid"?"grid":"stack",
  panels,tables,
  suggestions:list(z.string().trim().min(1),r.suggestions),
  ...(r.report===true?{report:true}:{}),
  ...(native?{nativeSpec:native}:{}),
  ...(valid(richPresentationBaseSchema.shape.pdfSpec,r.pdfSpec)?{pdfSpec:r.pdfSpec}:{}),
  ...(valid(richPresentationBaseSchema.shape.files,r.files)?{files:r.files}:{}),
  ...(agenda?{agenda}:{}),
  ...(scenario?{scenario}:{}),
  ...(calculator?{calculator}:{})});
 return repaired.success?repaired.data:undefined;
}

/** Text-only surfaces retain authored PDF information, including unresolved
 * state or unfamiliar components. Do not execute document bindings here. */
export function pdfDocumentDataLines(spec:Record<string,unknown>):string[]{
 const lines:string[]=[];
 const elements=spec.elements;
 if(elements&&typeof elements==="object"&&!Array.isArray(elements)){
  for(const node of Object.values(elements)){
   if(!node||typeof node!=="object"||Array.isArray(node))continue;
   const props=(node as Record<string,unknown>).props;
   if(!props||typeof props!=="object"||Array.isArray(props))continue;
   const values=props as Record<string,unknown>;
   for(const [key,value] of Object.entries(values)){
    if(value==null||["color","backgroundColor","borderColor","fontSize","fontWeight","fontStyle","align","level","width","height","margin","padding","orientation","size"].includes(key))continue;
    if(typeof value==="string")lines.push(key==="src"&&value.startsWith("data:image/")?"Embedded document image":value);
    else if(Array.isArray(value)&&key==="rows")for(const row of value)lines.push(Array.isArray(row)?row.map(cell=>cell==null?"Not recorded":typeof cell==="object"?JSON.stringify(cell):String(cell)).join(" | "):JSON.stringify(row));
    else lines.push(key+": "+JSON.stringify(value));
   }
  }
 }
 if(spec.state)lines.push("Document data: "+JSON.stringify(spec.state));
 return lines.length?lines:[JSON.stringify(spec)];
}

/** Preserve authored visual data on the existing text-only background report surfaces. */
export function presentationDataLines(block:RichPresentation):string[]{
 const lines:string[]=[];
 if(block.pdfSpec)lines.push(...pdfDocumentDataLines(block.pdfSpec));
 if(block.nativeSpec){
  const spec=block.nativeSpec,stateModel=spec.state??{};
  const pending:{key:string;ctx:PropResolutionContext}[]=[{key:spec.root,ctx:{stateModel,functions:nativeFunctions}}];
  while(pending.length){
   const {key,ctx}=pending.pop()!,e=spec.elements[key];if(!e)continue;
   const visibility=e.repeat&&ctx.repeatBasePath===undefined?splitRepeatVisibility(e.visible):{container:e.visible,itemFilter:undefined};
   if(visibility.container!==undefined&&!evaluateVisibility(visibility.container,ctx))continue;
   if(e.type==="LunaSnapshot"){const snapshot=recoverRichPresentation(readNativeSnapshot(e.props.snapshotJSON));if(snapshot&&!snapshot.nativeSpec)lines.push(...presentationDataLines(snapshot));}
   else{
    const props=resolveElementProps(e.props,ctx);
    if(e.type==="LunaFallback")lines.push(JSON.stringify(props.values)??String(props.values));
    for(const name of ["title","text","label","description","message","caption"]){if(typeof props[name]==="string"&&props[name])lines.push(props[name]);}
    if(Array.isArray(props.rows))for(const row of props.rows)if(Array.isArray(row))lines.push(row.map(v=>v==null?"Not recorded":String(v)).join(" | "));
    if(Array.isArray(props.points))for(const point of props.points)if(point&&typeof point==="object"&&"label" in point&&"value" in point)lines.push(String(point.label)+": "+String(point.value));
   }
   const children:{key:string;ctx:PropResolutionContext}[]=[];
   if(e.repeat){
    const path=resolveRepeatStatePath(e.repeat.statePath,ctx.repeatBasePath),items=path===undefined?undefined:getByPath(stateModel,path);
    if(path!==undefined&&Array.isArray(items))for(const [index,item] of items.entries()){
     const scope={...ctx,repeatItem:item,repeatIndex:index,repeatBasePath:resolveRepeatItemStatePath(path,index)};
     if(visibility.itemFilter===undefined||evaluateVisibility(visibility.itemFilter,scope))for(const key of e.children??[])children.push({key,ctx:scope});
    }
   }else for(const key of e.children??[])children.push({key,ctx});
   for(const slot of Object.values(e.slots??{}))for(const key of slot)children.push({key,ctx});
   pending.push(...children.reverse());
  }
  if(!lines.length)lines.push("Interactive view available in the conversation.");
 }
 for(const p of block.panels){
  lines.push("",p.title,p.sourceDetail??(p.source==="response_evidence"?"":p.source==="sql_research"?"SQL query":p.source),...(p.coverage&&p.source!=="response_evidence"?["Coverage: "+p.coverage]:[]),"Period: "+p.from+" – "+p.to+"; snapshot: "+p.asOf,
    ...p.points.map(point=>point.label+": "+point.value+" "+(p.measurement??p.unit)+(p.currency?" ("+p.currency+")":"")));
 }
 if(block.tables)for(const t of block.tables){
  lines.push("",t.title,[t.view==="tool_response_evidence"?"":t.view==="tool_sql_research"?"SQL query":t.view,t.coverage==="authored"||t.view==="tool_response_evidence"?"":t.coverage,t.scope].filter(Boolean).join(" · "),"Period: "+t.from+" – "+t.to+"; snapshot: "+t.asOf,
   t.columns.map(c=>c.label+" ("+c.unit+")").join(" | "),...t.rows.map(row=>row.map(v=>v===null?"Not recorded":String(v)).join(" | ")));
 }
 if(block.calculator){
  const c=block.calculator;lines.push("",c.title+" — saved starting calculation (hypothetical edits are not saved)",JSON.stringify(c.original));
 }
 if(block.agenda){
  const a=block.agenda;lines.push("",a.title,"Saved schedule/listing snapshot: "+a.asOf+"; coverage: "+a.coverage,
   ...a.entries.map(e=>[e.date,e.endDate,e.label,e.start??"Time not recorded",e.end??"",e.status,e.endUnknown?"End date unknown":"",e.checkedAt??""].join(" | ")));
 }
 if(block.scenario){
  const s=block.scenario;lines.push("",s.title+" — estimates only; no change made","Snapshot: "+s.asOf,
   ...s.cases.map(c=>c.assumption+": "+c.beforeCents+" → "+c.afterCents+" cents ("+s.currency+")"));
 }
 if(block.files?.length)lines.push("","Source attachments are available through the original authenticated conversation.");
 if(block.suggestions.length)lines.push("",...block.suggestions);
 if(block.report&&!lines.length)lines.push("Report available in the original conversation.");
 return lines;
}
export function backgroundReportPresentations(turn:{results?:readonly {source:string;accepted?:unknown;presentation?:unknown}[]}):RichPresentation[]{
 return (turn.results??[]).flatMap(result=>{
  if(result.source!=="response_presentation"||result.accepted!==true)return [];
  const block=recoverRichPresentation(result.presentation);
  return block?[block]:[];
 });
}
export function backgroundReportText(turn:{text:string;results?:readonly {source:string;accepted?:unknown;presentation?:unknown}[]}):string{
 return [turn.text.trim(),...backgroundReportPresentations(turn).map(block=>presentationDataLines(block).join("\n").trim())].filter(Boolean).join("\n\n");
}
