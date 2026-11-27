import {z} from "zod";
import {defineCatalog,defineSchema,createSpecStreamCompiler,type SpecStreamLine} from "@json-render/core";
import {schema} from "@json-render/react/schema";
import {standardComponentDefinitions as pdfComponents} from "@json-render/react-pdf/server";
import {upstreamComponents,nativeChartDefinition,validNativeSpec,recoverNativeDisplaySpec,safeNativeJSON,safeStatePath,safeKey,localActionNames} from "@/lib/ai/conversations/nativePresentation";
import {exactDecimal,CALC_OPS,type CalcOp} from "@/lib/metrics/core/calculator";
import {calculate} from "./tools.server";
import {normalizeTableData} from "@/lib/ai/conversations/tableFormatting";
import {presentationPanelSchema,recordTableSchema,recoverRichPresentation,descriptiveGroupTitle,interactiveCalcSchema,evaluatePresentationCalc,type InteractiveCalc,type PresentationPanel,type RecordTable,type RichPresentation} from "@/lib/ai/conversations/presentation";

/** Native inline GenUI vocabulary. Luna may author values directly or refer
 * to data already returned within this authenticated owner turn. */
const fieldPath=z.array(z.union([z.string().min(1),z.number().int().nonnegative()])).min(1);
const reference=z.object({ref:z.string(),path:fieldPath.optional(),quote:z.string().min(1).optional()}).refine(v=>Boolean(v.path)!==Boolean(v.quote));
const scalar=z.union([z.number().finite(),z.string(),z.boolean(),z.null()]);
const pointSelection=z.object({label:z.string().min(1),value:z.union([reference,scalar]),labelField:reference.optional(),unit:z.string().optional(),basis:z.string().optional()});
const pointPanel=z.object({kind:z.enum(["metric","bar","line","donut","ranked_table"]),title:z.string().optional(),basis:z.string().optional(),explanation:z.string().optional(),points:z.array(pointSelection).min(1)});

// Direct model-authored analysis is not a claim of stored business evidence.
const analysisPanel=z.object({kind:z.string().optional(),title:z.string().optional(),
 unit:z.string().optional(),
 measurement:z.string().optional(),basis:z.string().optional(),
 explanation:z.string().optional(),points:z.array(z.object({label:z.string(),value:scalar})).min(1)});

const selection=z.object({
 ref:z.string(),kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 x:z.string().optional(),y:z.string().optional(),columns:z.array(z.string()).optional(),title:z.string().optional(),
});
const calcSelection=z.object({ref:z.string(),editable:z.array(z.string())});
const directCalc=z.object({title:z.string().optional(),inputs:z.array(z.object({name:z.string(),value:z.string(),unit:z.enum(["cents","count","percent","ratio"])})).min(1),steps:z.array(z.object({id:z.string(),op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),args:z.array(z.string())})).min(1),editable:z.array(z.string())});
const authoredTable=z.object({title:z.string().optional(),basis:z.string().optional(),explanation:z.string().optional(),columns:z.array(z.string().min(1)).min(1),rows:z.array(z.array(z.union([z.string(),z.number().finite(),z.boolean(),z.null()]))).min(1)});
function normalizeAuthoredTable(value:unknown):unknown{
 if(!obj(value)||!Array.isArray(value.rows))return value;
 return {...value,...normalizeTableData(value.columns,value.rows)};
}
const envelope=z.object({layout:z.enum(["stack","grid"]).optional(),panels:z.array(z.union([selection,pointPanel,analysisPanel])).optional(),
 tables:z.array(authoredTable).optional(),report:z.boolean().optional(),files:z.boolean().optional(),calculator:z.union([calcSelection,directCalc]).optional()});
const components={
 ...upstreamComponents,
 LunaChart:nativeChartDefinition,
 DataView:{props:envelope,slots:[],description:"Metrics, charts, tables, calculators, report and authenticated attachments. For rows use ref, x, y or columns. For individual values, including across sources, use points with label and value:{ref,path:[exact field names and array indices]}; for text use value:{ref,quote:exact numeric token including currency symbol if present}. For dated or numeric category labels use labelField:{ref,path}. A calculate result can supply an editable calculator, or author calculator inputs, steps and editable input names directly with a title; direct inputs are hypothetical unless explained otherwise. You can also author a panel directly with kind, title, unit, basis (calculated, estimate or scenario), explanation and points [{label,value}]. Use cents for money in minor units; null means unknown, not zero. You can also author tables directly using tables:[{title,basis,explanation,columns:[label],rows:[[value]]}]. Basis and explanation are optional descriptions authored by Luna. The renderer does not judge the answer.",example:{layout:"grid",panels:[{ref:"q1",kind:"bar",x:"category",y:"amount_cents"}]}},
};
// Generate the vocabulary from the installed catalog, without demo-data instructions.
// Use the library's generated grammar, catalog schemas, events and default
// interaction documentation. Compatible upstream additions flow through the
// installed package without a hand-maintained prompt or widget inventory.
const catalog=defineCatalog(defineSchema(()=>schema.definition,{
 builtInActions:(schema.builtInActions??[]).filter(a=>localActionNames.has(a.name)),
 defaultRules:schema.defaultRules,
}),{components,actions:{}});
const generatedHint=catalog.prompt({mode:"inline",
 system:"You compose the actual owner-facing answer. Choose natural Markdown and native visuals independently of retrieval method. A text-only answer is always appropriate if useful. Use native state and the full web component catalog for interactive reports and scenario tools. Use actual records or clearly identified model assumptions, never fabricate missing data.",
 customRules:[
  "Use separate spec fences for independent UI sections anywhere in the answer; continue ordinary prose between them. DataView resolves already returned SQL, owner-provided data or authored financial analysis, and LunaChart accepts native state-bound points.",
  "Example DataView node: "+JSON.stringify({type:"DataView",props:components.DataView.example,children:[]}),
  "A state field is only needed when using state-dependent expressions or interactions, not for direct values. All local interactions and acyclic watches are supported. Use the actual listed local actions only; no remote API calls or business actions from widgets.",
  "Use any relevant numbers including derived, hypothetical and estimated figures. The application does not grade the analysis or require matching database values. Explain assumptions when useful. Do not invent data for empty results.",
  "For a state-derived calculation, use "+JSON.stringify({$computed:"calculate",args:{inputs:[{name:"sales",unit:"cents",value:{$state:"/sales"}},{name:"factor",unit:"ratio",value:{$state:"/factor"}}],steps:[{id:"forecast",op:"multiply",args:["sales","factor"]}],format:"number"}})+". Omit format for numeric output. Format supports number, currency or percent; for currency supply the actual business currency. The format computed function accepts {value,currency?}. Chart points can use these expressions, too.",
  "Images and avatars support embedded raster images; private files use existing authenticated attachments. HTTPS links require a user click. No executable JavaScript, arbitrary network actions, or access to other message/application state.",
 ]});
// The general-purpose demo instructions in the upstream prompt are unsuitable
// for live business records. Remove only those and the example remote action;
// the remaining native UI grammar is supplied by the installed library.
export const INLINE_PRESENTATION_HINT=generatedHint.split("\n").filter(line=>!/realistic.*sample data|never leave arrays empty|loadCities|side effects \(loading data/i.test(line)).join("\n")+
 "\nPDF documents: when the owner requests a downloadable PDF, use an independent spec fence with a Document root and Page children. The existing spec patch grammar applies. The following is the complete installed PDF catalog (distinct from the web catalog); author the document layout and content directly. Numeric table cells are adapted by the application. Images can be embedded PNG/JPEG data, not external or local file paths. No action bindings are needed in a static PDF. You can also set DataView.report to true to export the existing answer without authoring a separate document.\n"+
 JSON.stringify(Object.fromEntries(Object.entries(pdfComponents).map(([name,definition])=>[name,{description:definition.description,props:z.toJSONSchema(definition.props,{unrepresentable:"any"})}])));

type Selection=z.infer<typeof selection>;
export type PresentationContext={asOf:string;currency?:string|null;presentationAttachments?:readonly string[]};
type Context=PresentationContext;
type Row=Record<string,unknown>;
export type PresentationEvidence={data:Row;source:string;kind?:"sql"|"calculator";coverage?:"partial"|"estimate";text?:string};
export type PresentationEvidenceMap=ReadonlyMap<string,PresentationEvidence>;
const obj=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const name=(key:string)=>key.replaceAll("_"," ").trim();
const visible=(key:string)=>!/(?:^|[._])(?:id|ref|email|phone|password|secret|credential|token|authorization|cookie)(?:$|[._])/iu.test(key)&&!/(?:Id|Ref|Token|Secret|Password|Credential|Email|Phone|Cookie)$/u.test(key)&&!["__proto__","prototype","constructor"].includes(key);
const unit=(key:string)=>/(?:^|_)cents$|Cents$/u.test(key)?"cents":/(?:^|_)(?:count|orders|quantity)$|(?:Count|Orders|Quantity)$/u.test(key)?"count":"stored";
const rawCell=(v:unknown)=>v===null||["string","boolean","number"].includes(typeof v);
const title=(s:Selection,fallback:string)=>descriptiveGroupTitle(s.title)||fallback||"Query results";

function table(s:Selection,rows:Row[],ctx:Context,e:PresentationEvidence):RecordTable|null{
 const keys=s.columns??[s.x,s.y].filter((v):v is string=>typeof v==="string");
 if(!keys.length||keys.some(k=>!visible(k)))return null;
 const columns=keys.map(k=>({label:name(k),unit:unit(k)==="cents"&&rows.every(r=>r[k]==null||typeof r[k]==="number")?"cents":unit(k)==="count"&&rows.every(r=>r[k]==null||typeof r[k]==="number")?"count":"stored"}));
 const result=recordTableSchema.safeParse({title:title(s,"Query results"),view:e.kind==="sql"?"tool_sql_research":"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
  currency:ctx.currency??null,coverage:"stored",
  scope:e.source,
  columns,rows:rows.map(r=>keys.map(k=>rawCell(r[k])?r[k]:null))});
 return result.success?result.data:null;
}
function panel(s:Selection,rows:Row[],ctx:Context,e:PresentationEvidence):PresentationPanel|null{
 if(!s.y||!visible(s.y)||s.x&&!visible(s.x))return null;
 const y=s.y,x=s.x;
 if(!x&&rows.length!==1)return null;
 const u=unit(y),currency=u==="cents"?ctx.currency??null:null;
 const chartUnit=u==="cents"?"cents":u==="count"?"count":"units";

 const points=rows.map(r=>({label:safeLabel(x?r[x]:name(y)),value:r[y]}));
 if(points.some(p=>(typeof p.label!=="string"&&typeof p.label!=="number")||typeof p.value!=="number"||!Number.isFinite(p.value)))return null;
 const typed=points.map(p=>({label:String(p.label),value:p.value as number}));

 if(s.kind==="ranked_table")typed.sort((a,b)=>b.value-a.value);
 // The chart is a view of the query, not a claim of complete underlying
 // records. Do not infer missing time buckets or manufacture a denominator.

 const p=presentationPanelSchema.safeParse({kind:s.kind,title:title(s,name(y)),unit:chartUnit,currency,
  from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,source:e.kind==="sql"?"sql_research":"response_evidence",sourceDetail:e.source,
  ...(chartUnit==="units"?{measurement:name(y)}:{}),points:typed});
 return p.success?p.data:null;
}

function calculator(raw:Row,editable:string[],ctx:Context):InteractiveCalc|null{
 if(raw.ok!==true||!obj(raw.calculationInput)||!obj(raw.result))return null;
 const {inputs,steps}=raw.calculationInput;
 if(!Array.isArray(inputs)||!Array.isArray(steps))return null;
 const shown=(v:unknown,u:unknown)=>{
  if(typeof v!=="string"||!/^[-+]?(?:\d+\.?\d*|\.\d+)$/u.test(v))return null;
  const n=Number(v);
  if(!Number.isFinite(n))return null;
  if(u==="cents"&&Number.isSafeInteger(n))return {unit:u,valueCents:n};
  if(u==="percent"&&Number.isSafeInteger(Math.round(n*100))&&Math.round(n*100)/100===n)return {unit:u,valueBps:Math.round(n*100)};
  if(u==="count")return {unit:u,quantity:n};
  if(u==="ratio")return {unit:u,valueRatio:n};
  return null;
 };
 const parsed=interactiveCalcSchema.safeParse({title:"What-if calculation",asOf:ctx.asOf,currency:ctx.currency??null,
  inputs:inputs.map(i=>obj(i)?{id:i.name,label:name(String(i.name)),value:shown(i.value,i.unit),editable:editable.includes(String(i.name))}:null),
  steps,original:shown(raw.result.value,raw.result.unit)});
 if(!parsed.success)return null;
 const reproduced=evaluatePresentationCalc(parsed.data);
 return reproduced&&JSON.stringify(reproduced)===JSON.stringify(parsed.data.original)?parsed.data:null;
}

/** Own-property lookup on the already authorized result, with no implicit
 * database reads, arbitrary code, or hidden object identifiers. */
function field(data:unknown,path:readonly (string|number)[]):unknown{
 let value=data;
 for(const key of path){
  if(typeof key==="number"){
   if(!Array.isArray(value)||!Object.hasOwn(value,key))return;
   value=value[key];
  }else{
   if(!visible(key)||!obj(value)||!Object.hasOwn(value,key))return;
   value=value[key];
  }
 }
 return value;
}
function textToken(text:string,quote:string,ctx:Context):{value:number;unit:PresentationPanel["unit"];measurement?:string}|undefined{
 // A complete literal, never a substring of a different amount, date or ID.
 const matches=[...text.matchAll(/(?<![\p{L}\p{N}.,:-])[-+]?(?:[$€£¥]\s*|[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|\s+[A-Z]{3})?(?![\p{L}\p{N}:]|[.,-]\d)/gu)];
 if(!matches.some(m=>m[0]===quote))return;
 const match=/^([-+]?)(?:([$€£¥]|[A-Z]{3})\s*)?([\d,]+(?:\.\d+)?)(%|\s+[A-Z]{3})?$/u.exec(quote);
 if(!match)return;
 const raw=match[1]+match[3].replaceAll(",","");
 const money=match[2]??(match[4]?.trim()!=="%"?match[4]?.trim():undefined);
 if(money){
  if(!ctx.currency)return;
  let symbol:string|undefined;
  try{symbol=new Intl.NumberFormat("en",{style:"currency",currency:ctx.currency}).formatToParts(0).find(x=>x.type==="currency")?.value;}catch{return;}
  if(money!==ctx.currency&&money!==symbol)return;
  const amount=exactDecimal(raw,"cents");if(!amount)return;
  const cents=amount.n*BigInt(100);if(cents%amount.d!==BigInt(0))return;
  const value=Number(cents/amount.d);
  return Number.isSafeInteger(value)?{value,unit:"cents"}:undefined;
 }
 const value=Number(raw);
 if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return;
 return match[4]==="%"?{value,unit:"units",measurement:"%"}:
  {value,unit:Number.isSafeInteger(value)?"count":"units"};
}
type BoundValue={value:number;unit:PresentationPanel["unit"];measurement?:string};
function bindValue(e:PresentationEvidence,r:z.infer<typeof reference>,ctx:Context):BoundValue|undefined{
 if(r.quote!==undefined)return e.text?textToken(e.text,r.quote,ctx):undefined;
 if(!r.path)return;
 const raw=field(e.data,r.path);
 const key=String(r.path.at(-1));
 const parent=field(e.data,r.path.slice(0,-1));
 // Calculation result and steps expose decimal values together with their
 // explicit unit; ordinary fields keep the returned minor-unit convention.
 if(key==="value"&&obj(parent)&&typeof raw==="string"&&["cents","count","percent","ratio"].includes(String(parent.unit))){
  const exact=exactDecimal(raw,parent.unit==="cents"?"cents":parent.unit==="percent"?"percent":parent.unit==="ratio"?"ratio":"count");
  if(!exact)return;
  const v=Number(raw);
  if(!Number.isFinite(v)||Math.abs(v)>Number.MAX_SAFE_INTEGER)return;
  if(parent.unit==="cents")return Number.isSafeInteger(v)?{value:v,unit:"cents"}:undefined;
  if(parent.unit==="percent")return {value:v,unit:"units",measurement:"%"};
  return {value:v,unit:parent.unit==="ratio"?"ratio":Number.isSafeInteger(v)?"count":"units"};
 }
 if(typeof raw!=="number"||!Number.isFinite(raw))return;
 const u=unit(key);
 return {value:raw,unit:u==="stored"?"units":u};
}
function safeLabel(v:unknown):string|undefined{
 if(typeof v!=="string"&&typeof v!=="number")return;
 const s=String(v).trim();
 return s.length>0&&!/[\w.-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(s)?s:undefined;
}
/** A series may combine exact values from independently admitted sources.
 * Do not combine different units, promote a historic claim, or silently
 * discard a missing point. One malformed series does not erase its siblings. */
function pointView(s:z.infer<typeof pointPanel>,evidence:PresentationEvidenceMap,ctx:Context):PresentationPanel|null{
 const values:(BoundValue&{label:string;source:PresentationEvidence})[]=[];
 for(const item of s.points){
  const selected=reference.safeParse(item.value);
  if(!selected.success)return null;
  const source=evidence.get(selected.data.ref);
  if(!source)return null;
  const bound=bindValue(source,selected.data,ctx);
  if(!bound)return null;
  const labelSource=item.labelField?evidence.get(item.labelField.ref):undefined;
  const label=item.labelField?(labelSource&&item.labelField.path?safeLabel(field(labelSource.data,item.labelField.path)):undefined):
   descriptiveGroupTitle(item.label);
  if(!label)return null;
  values.push({...bound,label,source});
 }
 const first=values[0];
 if(values.some(v=>v.unit!==first.unit||v.measurement!==first.measurement))return null;
 const sourceDetail=[s.basis,s.explanation,...new Set(values.map(v=>v.source.source))].filter(Boolean).join("; ");
 const result=presentationPanelSchema.safeParse({kind:s.kind,title:descriptiveGroupTitle(s.title)??"Comparison",
  unit:first.unit,currency:first.unit==="cents"?ctx.currency??null:null,from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
  source:"response_evidence",sourceDetail,...(first.measurement?{measurement:first.measurement}:{}),
  points:values.map(({label,value})=>({label,value}))});
 return result.success?result.data:null;
}

/** Bind a selected component to the existing validated presentation blocks. */
export function resolveResearchView(raw:unknown,queries:PresentationEvidenceMap,ctx?:Context,onDeliveryLoss?:()=>void):RichPresentation|undefined{
 if(!obj(raw)||!ctx){onDeliveryLoss?.();return;}
 const panels:PresentationPanel[]=[],tables:RecordTable[]=[];
 const layout=raw.layout==="grid"?"grid":"stack";
 const c=calcSelection.safeParse(raw.calculator);
 const authored=directCalc.safeParse(raw.calculator);
 const calculated=authored.success?calculator({...calculate(authored.data),calculationInput:authored.data},authored.data.editable,ctx):null;
 const calc=c.success?calculator(queries.get(c.data.ref)?.data??{},c.data.editable,ctx):calculated&&{...calculated,title:descriptiveGroupTitle(authored.success?authored.data.title:undefined)??"What-if calculation"};
 if(!calc&&authored.success){
  const a=authored.data;
  const result=recordTableSchema.safeParse({title:a.title??"What-if calculation",view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency:ctx.currency??null,coverage:"authored",
   scope:"Luna's hypothetical inputs. The interactive calculation could not be evaluated; these inputs are retained.",
   columns:[{label:"Input",unit:"label"},{label:"Value",unit:"stored"},{label:"Unit",unit:"stored"}],rows:a.inputs.map(i=>[i.name,i.value,i.unit])});
  if(result.success)tables.push(result.data);
 }
 for(const value of Array.isArray(raw.panels)?raw.panels:[]){
  const direct=analysisPanel.safeParse(value);
  if(direct.success){
   const a=direct.data;
   const heading=descriptiveGroupTitle(a.title)??"Luna analysis";
   const coverage=a.basis==="estimate"?"estimate":a.basis==="partial"?"partial":a.basis==="unverified"?"unverified":undefined;
   const detail=[a.basis,a.explanation].filter(Boolean).join(": ");
   const points=a.points.map(p=>({label:descriptiveGroupTitle(p.label)??"Value",value:p.value}));
   const supported=presentationPanelSchema.shape.unit.safeParse(a.unit);
   const displayUnit=supported.success?supported.data:"units";
   const measurement=a.measurement??(supported.success?undefined:a.unit);
   const currency=["cents","cents/hour"].includes(displayUnit)?ctx.currency??null:null;
   const modelPanel=presentationPanelSchema.safeParse({kind:presentationPanelSchema.shape.kind.safeParse(a.kind).success?a.kind:"table",title:heading,unit:displayUnit,currency,from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
     source:"response_evidence",...(detail?{sourceDetail:detail}:{}),coverage,...(measurement?{measurement}:{}),points});
   if(modelPanel.success)panels.push(modelPanel.data);
   else{
    const numeric=points.every(p=>p.value===null||typeof p.value==="number");
    const fallback=recordTableSchema.safeParse({title:heading,view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency,
     coverage:coverage??"authored",scope:detail,columns:[{label:"Category",unit:"label"},{label:measurement??displayUnit,unit:numeric?displayUnit:"stored"}],
     rows:points.map(p=>[p.label,p.value])});
    if(fallback.success)tables.push(fallback.data);
   }
   continue;
  }
  const selectedPoints=pointPanel.safeParse(value);
  if(selectedPoints.success){
   const p=pointView(selectedPoints.data,queries,ctx);
   if(p)panels.push(p);
   else{
    const rows=selectedPoints.data.points.map(item=>{
     const selected=reference.safeParse(item.value);
     const e=selected.success?queries.get(selected.data.ref):undefined,bound=e&&selected.success?bindValue(e,selected.data,ctx):undefined;
     const labelEvidence=item.labelField?queries.get(item.labelField.ref):undefined;
     const label=item.labelField?.path&&labelEvidence?safeLabel(field(labelEvidence.data,item.labelField.path)):descriptiveGroupTitle(item.label);
     const direct=scalar.safeParse(item.value);
     const raw=selected.success&&selected.data.path&&e?field(e.data,selected.data.path):undefined;
     const cell=scalar.safeParse(raw);
     return [label??"Value",direct.success?direct.data:bound?.value??(cell.success?cell.data:null),direct.success?item.unit??null:bound?bound.measurement??bound.unit:null];
    });
    const t=recordTableSchema.safeParse({title:selectedPoints.data.title??"Comparison",view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency:ctx.currency??null,
     coverage:"authored",scope:[selectedPoints.data.basis,selectedPoints.data.explanation,"Unresolved references are displayed as unknown."].filter(Boolean).join("; "),
     columns:[{label:"Category",unit:"label"},{label:"Value",unit:"stored"},{label:"Unit",unit:"stored"}],rows});
    if(t.success)tables.push(t.data);
   }
   continue;
  }
  const s=selection.safeParse(value);if(!s.success)continue;
  const e=queries.get(s.data.ref),q=e?.data;
  if(!e||!q||q.ok===false||q.error||!Array.isArray(q.rows)||!q.rows.length||!q.rows.every(obj)){
   const t=recordTableSchema.safeParse({title:s.data.title??"Selected results",view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency:ctx.currency??null,
    coverage:"authored",scope:"The selected reference did not return rows.",columns:[{label:"Value",unit:"stored"}],rows:[[null]]});
   if(t.success)tables.push(t.data);
   continue;
  }
  if(s.data.kind==="table"){
   const t=table(s.data,q.rows,ctx,e);if(t)tables.push(t);
  }else{
   const p=panel(s.data,q.rows,ctx,e);
   if(p)panels.push(p);
   else {const t=table(s.data,q.rows,ctx,e);if(t)tables.push(t);}
  }
 }
 for(const rawTable of Array.isArray(raw.tables)?raw.tables:[]){
  const t=authoredTable.safeParse(normalizeAuthoredTable(rawTable));if(!t.success)continue;
  const a=t.data, width=a.rows.reduce((n,r)=>Math.max(n,r.length),a.columns.length);
  const columns=Array.from({length:width},(_,i)=>({label:a.columns[i]??"Value "+(i+1),unit:"stored"}));
  const result=recordTableSchema.safeParse({title:descriptiveGroupTitle(a.title)??"Luna analysis",view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency:ctx.currency??null,
   coverage:a.basis==="estimate"?"estimate":a.basis==="partial"?"partial":a.basis==="unverified"?"unverified":"authored",scope:[a.basis,a.explanation].filter(Boolean).join(": "),
   columns,rows:a.rows.map(row=>Array.from({length:width},(_,i)=>row[i]??null))});
  if(result.success)tables.push(result.data);
 }
 const attachments=raw.files===true?[...new Set(ctx.presentationAttachments??[])].slice(0,3):[];
 const block=recoverRichPresentation({type:"rich_presentation",version:1,layout,panels,suggestions:[],
  ...(tables.length?{tables}:{}),...(calc?{calculator:calc}:{}),...(raw.report===true?{report:true}:{}),...(attachments.length?{files:attachments}:{})});
 // Each requested data leaf has exactly one display path (including chart
 // or calculator fallbacks). Report only a technical delivery loss, never
 // an estimate, unknown value or confidence assessment.
 const requested=(value:unknown)=>Array.isArray(value)?value.length:value==null?0:1;
 const requestedLeaves=requested(raw.panels)+requested(raw.tables)+Number(raw.calculator!=null);
 const deliveredLeaves=(block?.panels.length??0)+(block?.tables?.length??0)+Number(Boolean(block?.calculator));
 if(!block||deliveredLeaves<requestedLeaves)onDeliveryLoss?.();
 return block;
}

/** Apply only data-only element tree patches, using the installed library's
 * compiler. Native interactions are isolated to local widget state.
 * Resolve each view independently so a malformed sibling cannot erase prose. */
export function resolveResearchSpec(patches:readonly unknown[],queries:PresentationEvidenceMap,ctx?:Context,onDeliveryLoss?:()=>void):RichPresentation[]{
 const compiler=createSpecStreamCompiler();
 for(const value of patches){
  if(!obj(value)||typeof value.path!=="string"||!["add","replace","remove"].includes(String(value.op))||(value.op!=="remove"&&!safeNativeJSON(value.value))){onDeliveryLoss?.();continue;}
  const parts=value.path.split("/").slice(1);
  if(value.path!=="/root"&&(!["elements","state"].includes(parts[0])||!safeStatePath(value.path)||parts.slice(1).some(k=>!safeKey(k)))){onDeliveryLoss?.();continue;}
  try{compiler.push(JSON.stringify(value as unknown as SpecStreamLine)+"\n");}catch{onDeliveryLoss?.();}
 }
 let spec:ReturnType<typeof compiler.getResult>;
 try{spec=compiler.getResult();}catch{onDeliveryLoss?.();return [];}
 if(!obj(spec.elements))return [];
 const rootElement=typeof spec.root==="string"?spec.elements[spec.root]:undefined;
 if(obj(rootElement)&&rootElement.type==="Document"){
  // Keep the authored PDF document in the existing saved-answer envelope.
  const pdfSpec:unknown=JSON.parse(JSON.stringify({root:spec.root,elements:spec.elements,...(spec.state?{state:spec.state}:{})}));
  const report=recoverRichPresentation({type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],report:true,pdfSpec});
  if(report?.pdfSpec)return [report];
  onDeliveryLoss?.();return [];
 }
 // Native widgets and DataView snapshots share a single persisted element tree.
 // Old DataView-only fences retain their established wire representation.
 const native=Boolean(spec.state)||Object.values(spec.elements).some(e=>obj(e)&&(e.type!=="DataView"&&e.type!=="Stack"||e.type==="Stack"&&obj(e.props)&&Object.keys(e.props).length>0||e.on||e.watch||e.visible||e.repeat||e.slots));
 if(native&&ctx&&typeof spec.root==="string"&&!Object.values(spec.elements).some(e=>obj(e)&&e.type==="LunaSnapshot")){
  const elements=Object.fromEntries(Object.entries(spec.elements).map(([key,e])=>{
   if(!obj(e))return [key,e];
   if(e.type==="LunaChart"&&obj(e.props))return [key,{...e,props:{...e.props,asOf:ctx.asOf}}];
   if(e.type!=="DataView")return [key,e];
   const snapshot=resolveResearchView(e.props,queries,ctx,onDeliveryLoss);
   return [key,{type:"LunaSnapshot",props:{snapshotJSON:JSON.stringify(snapshot??{type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[]})},children:[],...(e.visible!==undefined?{visible:e.visible}:{}),...(e.repeat!==undefined?{repeat:e.repeat}:{})}];
  }));
  const candidate:unknown=JSON.parse(JSON.stringify({root:spec.root,elements,...(spec.state?{state:spec.state}:{})}));
  const display=validNativeSpec(candidate)?candidate:recoverNativeDisplaySpec(candidate);
  if(display){
   const view=recoverRichPresentation({type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],nativeSpec:display});if(view)return [view];
  }
 }
 if(native)onDeliveryLoss?.();
 const visited=new Set<string>(),result:RichPresentation[]=[];
 const walk=(root:string)=>{
  const pending=[root];
  while(pending.length){
   const key=pending.pop()!;
   if(visited.has(key)||!safeKey(key))continue;visited.add(key);
   const element=Object.hasOwn(spec.elements as Row,key)?(spec.elements as Row)[key]:null;
   if(!obj(element))continue;
   if(element.type==="DataView"){const view=resolveResearchView(element.props,queries,ctx,onDeliveryLoss);if(view)result.push(view);}
   else if(Array.isArray(element.children))pending.push(...element.children.filter((v):v is string=>typeof v==="string").reverse());
  }
 };
 if(typeof spec.root==="string")walk(spec.root);
 // Recover authored data leaves even if a layout parent or root is malformed.
 for(const key of Object.keys(spec.elements))if(!visited.has(key))walk(key);
 return result;
}
