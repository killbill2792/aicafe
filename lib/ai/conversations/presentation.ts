import { z } from "zod";
import {exactNumber,runCalculation,CALC_OPS,type CalcOp,type CalcShown} from "@/lib/metrics/core/calculator";

/** Versioned, renderer-independent, serializable UI. No client code or action bindings. */
const label=z.string().min(1).max(140);
const date=z.iso.date();
const point=z.strictObject({label,value:z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)});
export const presentationPanelSchema=z.strictObject({
  kind:z.enum(["metric","table","ranked_table","bar","line","donut"]),
  title:label,unit:z.enum(["cents","count","items","seconds","minutes","hours"]),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
  from:date,to:date,asOf:date,source:z.enum(["daily_rollups","item_sales","profitability","canonical_data","expenses","business_costs","product_costs"]),
  sourceDetail:z.string().max(200).optional(),
  points:z.array(point).min(1).max(30),
}).superRefine((p,ctx)=>{
  if((p.unit==="cents")!==(p.currency!==null)||p.from>p.to||p.to>p.asOf||
     ((p.unit==="cents"||p.unit==="count")&&p.points.some(x=>!Number.isSafeInteger(x.value)))||
     (p.kind==="metric"&&p.points.length!==1)||
     (p.kind==="donut"&&(p.points.some(x=>x.value<0)||p.points.every(x=>x.value===0))))
    ctx.addIssue({code:"custom",message:"Invalid presentation data"});
});
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const agendaSchema=z.strictObject({
 kind:z.enum(["calendar","timeline"]),source:z.enum(["cafe_events","scheduled_shifts"]),
 title:label,from:date,to:date,asOf:date,coverage:z.enum(["saved","partial"]),
 entries:z.array(z.strictObject({label,date,endDate:date,start:clock.nullable(),end:clock.nullable(),
   status:z.enum(["found","cancelled","moved","unverified","app","toast","ai_draft"]),
   checkedAt:z.iso.datetime({offset:true}).nullable()})).min(1).max(40),
}).refine(a=>a.from<=a.to&&a.entries.every(e=>e.date<=e.endDate&&e.date<=a.to&&e.endDate>=a.from));
export const scenarioComparisonSchema=z.strictObject({
 title:label,currency:z.string().regex(/^[A-Z]{3}$/),asOf:date,
 provenance:z.literal("estimate"),
 cases:z.array(z.strictObject({assumption:label,beforeCents:z.number().int().safe(),afterCents:z.number().int().safe()})).min(1).max(8)
});
const tableUnit=z.enum(["label","local date","cents","count","items","seconds","minutes","hours","cents/hour","boolean","stored"]);
const cell=z.union([z.string().max(240),z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),z.boolean(),z.null()]);
export const recordTableSchema=z.strictObject({
 title:label,view:z.string().regex(/^cv_[a-z_]+$/).max(80),from:date,to:date,asOf:date,
 currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 coverage:z.enum(["stored","partial"]),scope:z.string().max(300),
 columns:z.array(z.strictObject({label,unit:tableUnit})).min(1).max(8),
 rows:z.array(z.array(cell).min(1).max(8)).min(1).max(30),
}).superRefine((t,ctx)=>{
 if(t.from>t.to||t.rows.some(r=>r.length!==t.columns.length||r.some((v,i)=>{
  if(v===null)return false;
  const u=t.columns[i].unit;
  return u==="cents"||u==="cents/hour"?(!t.currency||typeof v!=="number"||!Number.isSafeInteger(v)):
   u==="count"?typeof v!=="number"||!Number.isSafeInteger(v):
   u==="items"||u==="seconds"||u==="hours"||u==="minutes"?typeof v!=="number":
   u==="label"?typeof v!=="string":u==="local date"?typeof v!=="string"||!date.safeParse(v).success:u==="boolean"?typeof v!=="boolean":false;
 })))ctx.addIssue({code:"custom",message:"Invalid table cells"});
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
 inputs:z.array(z.strictObject({id:calcName,label,value:calcShown,editable:z.boolean()})).min(1).max(12),
 steps:z.array(z.strictObject({id:calcName,op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),args:z.array(calcName).min(1).max(8)})).min(1).max(12),
 original:calcShown,
}).refine(c=>c.inputs.some(i=>i.editable)&&c.inputs.every(i=>!i.editable||i.value.unit!=="ratio")&&
 new Set(c.inputs.map(i=>i.id)).size===c.inputs.length&&
 (c.currency!==null||![...c.inputs.map(i=>i.value),c.original].some(v=>v.unit==="cents")));
export type RecordTable=z.infer<typeof recordTableSchema>;
export type InteractiveCalc=z.infer<typeof interactiveCalcSchema>;
/** Reuse the one exact arithmetic engine. Local values are hypothetical, never
 * written to the business or attached to an approval or trusted output. */
export function evaluatePresentationCalc(c:InteractiveCalc,changes:Readonly<Record<string,string>>={}):CalcShown|null{
 const entries=new Map<string,NonNullable<ReturnType<typeof exactNumber>>>();
 for(const input of c.inputs){
  const v=input.value;
  let n=v.unit==="cents"?v.valueCents:v.unit==="percent"?v.valueBps:v.unit==="count"?v.quantity:v.valueRatio;
  if(input.editable&&Object.hasOwn(changes,input.id)){
   const raw=changes[input.id];
   if(!/^-?\d{1,9}(?:\.\d{1,2})?$/.test(raw))return null;
   const entered=Number(raw);
   // Minor values/percentage basis points are integers. Limit editable
   // hypothetical inputs to nine whole digits and two decimal places.
   n=v.unit==="cents"||v.unit==="percent"?Math.round(entered*100):entered;
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
export const presentationGroupSchema=z.strictObject({layout:z.enum(["stack","grid","compare"]),items:z.array(z.string().regex(/^(?:panel[0-3]|table[01]|agenda|scenario|calculator)$/)).min(1).max(9)});
export const richPresentationSchema=z.strictObject({
  type:z.literal("rich_presentation"),version:z.literal(1),
  layout:z.enum(["stack","grid"]),
  panels:z.array(presentationPanelSchema).max(4),
  groups:z.array(presentationGroupSchema).min(1).max(9).optional(),
  report:z.literal(true).optional(),
  files:z.array(z.uuid()).min(1).max(3).refine(ids=>new Set(ids).size===ids.length).optional(),
  tables:z.array(recordTableSchema).max(2).optional(),
  calculator:interactiveCalcSchema.optional(),
  agenda:agendaSchema.optional(),
  scenario:scenarioComparisonSchema.optional(),
  suggestions:z.array(z.string().trim().min(1).max(160)).max(3),
}).refine(p=>p.panels.length+p.suggestions.length+Number(Boolean(p.agenda))+Number(Boolean(p.scenario))+Number(Boolean(p.report))+Number(Boolean(p.calculator))+(p.tables?.length??0)+(p.files?.length??0)>0).refine(p=>{
 if(!p.groups)return true;
 const keys=presentationLeaves(p),used=p.groups.flatMap(g=>g.items);
 return used.length===keys.length&&new Set(used).size===used.length&&used.every(k=>keys.includes(k))&&p.groups.every(g=>g.layout!=="compare"||compatibleComparison(g.items,p.panels));
});
export type RichPresentation=z.infer<typeof richPresentationSchema>;
export type PresentationPanel=z.infer<typeof presentationPanelSchema>;
export function presentationLeaves(p:Pick<RichPresentation,"panels"|"tables"|"agenda"|"scenario"|"calculator">):string[]{
 return [...p.panels.map((_,i)=>"panel"+i),...(p.agenda?["agenda"]:[]),...(p.scenario?["scenario"]:[]),...(p.tables??[]).map((_,i)=>"table"+i),...(p.calculator?["calculator"]:[])];
}
export function compatibleComparison(items:string[],panels:PresentationPanel[]):boolean{
 if(items.length<2||items.some(k=>!/^panel[0-3]$/.test(k)))return false;
 const series=items.map(k=>panels[Number(k.slice(5))]);
 if(series.some(p=>!p||p.kind==="donut"))return false;
 const first=series[0];
 // Exact matching categories or a shared daily axis. Never align unrelated
 // labels, or mix incompatible measurement units/currencies on one axis.
 return series.every(p=>p.unit===first.unit&&p.currency===first.currency)&&
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
 for(const p of block.panels){
  lines.push("",p.title,p.sourceDetail??p.source,"Period: "+p.from+" – "+p.to+"; snapshot: "+p.asOf,
    ...p.points.map(point=>point.label+": "+point.value+" "+p.unit+(p.currency?" ("+p.currency+")":"")));
 }
 if(block.tables)for(const t of block.tables){
  lines.push("",t.title,t.view+" · "+t.coverage+" · "+t.scope,"Period: "+t.from+" – "+t.to+"; snapshot: "+t.asOf,
   t.columns.map(c=>c.label+" ("+c.unit+")").join(" | "),...t.rows.map(row=>row.map(v=>v===null?"Not recorded":String(v)).join(" | ")));
 }
 if(block.calculator){
  const c=block.calculator;lines.push("",c.title+" — saved starting calculation (hypothetical edits are not saved)",JSON.stringify(c.original));
 }
 if(block.agenda){
  const a=block.agenda;lines.push("",a.title,"Saved schedule/listing snapshot: "+a.asOf+"; coverage: "+a.coverage,
   ...a.entries.map(e=>[e.date,e.endDate,e.label,e.start??"Time not recorded",e.end??"",e.status,e.checkedAt??""].join(" | ")));
 }
 if(block.scenario){
  const s=block.scenario;lines.push("",s.title+" — estimates only; no change made","Snapshot: "+s.asOf,
   ...s.cases.map(c=>c.assumption+": "+c.beforeCents+" → "+c.afterCents+" cents ("+s.currency+")"));
 }
 if(block.files?.length)lines.push("","Source attachments are available through the original authenticated conversation.");
 lines.push("","Export only. Refer to the original conversation for approvals, work status and current evidence.");
 return lines.join("\n");
}
