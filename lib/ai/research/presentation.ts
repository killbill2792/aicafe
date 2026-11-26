import {z} from "zod";
import {defineCatalog,defineSchema,createSpecStreamCompiler,type SpecStreamLine} from "@json-render/core";
import {schema} from "@json-render/react/schema";
import {exactDecimal,CALC_OPS,type CalcOp} from "@/lib/metrics/core/calculator";
import {calculate} from "./tools.server";
import {presentationPanelSchema,recordTableSchema,recoverRichPresentation,descriptiveGroupTitle,interactiveCalcSchema,evaluatePresentationCalc,type InteractiveCalc,type PresentationPanel,type RecordTable,type RichPresentation} from "@/lib/ai/conversations/presentation";

/** Native inline GenUI vocabulary. All data values bind to the evidence already
 * admitted to this owner turn, irrespective of its retrieval mechanism. */
const fieldPath=z.array(z.union([z.string().min(1).max(140),z.number().int().nonnegative()])).min(1).max(12);
const reference=z.object({ref:z.string(),path:fieldPath.optional(),quote:z.string().min(1).max(100).optional()}).refine(v=>Boolean(v.path)!==Boolean(v.quote));
const pointSelection=z.object({label:z.string().min(1),value:reference,labelField:reference.optional()});
const pointPanel=z.object({kind:z.enum(["metric","bar","line","donut","ranked_table"]),title:z.string().optional(),points:z.array(pointSelection).min(1)});

// Direct model-authored analysis is not a claim of stored business evidence.
const analysisPanel=z.object({kind:z.enum(["metric","bar","line","donut","ranked_table"]),title:z.string().optional(),
 unit:z.enum(["cents","count","items","units","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour"]),
 measurement:z.string().optional(),basis:z.enum(["calculated","estimate","scenario","actual","unverified"]).optional(),
 explanation:z.string().optional(),points:z.array(z.object({label:z.string(),value:z.union([z.number().finite(),z.string(),z.null()])})).min(1)});

const selection=z.object({
 ref:z.string(),kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 x:z.string().optional(),y:z.string().optional(),columns:z.array(z.string()).optional(),title:z.string().optional(),
});
const calcSelection=z.object({ref:z.string(),editable:z.array(z.string())});
const directCalc=z.object({title:z.string().optional(),inputs:z.array(z.object({name:z.string(),value:z.string(),unit:z.enum(["cents","count","percent","ratio"])})).min(1),steps:z.array(z.object({id:z.string(),op:z.enum(CALC_OPS as [CalcOp,...CalcOp[]]),args:z.array(z.string())})).min(1),editable:z.array(z.string())});
const authoredTable=z.object({title:z.string().optional(),basis:z.enum(["calculated","estimate","scenario","actual","unverified"]).optional(),explanation:z.string().optional(),columns:z.array(z.string().min(1)).min(1),rows:z.array(z.array(z.union([z.string(),z.number().finite(),z.boolean(),z.null()]))).min(1)});
const envelope=z.object({layout:z.enum(["stack","grid"]).optional(),panels:z.array(z.union([selection,pointPanel,analysisPanel])).optional(),
 tables:z.array(authoredTable).optional(),report:z.boolean().optional(),files:z.boolean().optional(),calculator:z.union([calcSelection,directCalc]).optional()});
const components={
 Stack:{props:z.object({}),slots:["default"],description:"Group views in their displayed order.",example:{}},
 DataView:{props:envelope,slots:[],description:"Metrics, charts, tables, calculators, report and authenticated attachments. For rows use ref, x, y or columns. For individual values, including across sources, use points with label and value:{ref,path:[exact field names and array indices]}; for text use value:{ref,quote:exact numeric token including currency symbol if present}. For dated or numeric category labels use labelField:{ref,path}. A calculate result can supply an editable calculator, or author calculator inputs, steps and editable input names directly with a title; direct inputs are hypothetical unless explained otherwise. You can also author a panel directly with kind, title, unit, basis (calculated, estimate or scenario), explanation and points [{label,value}]. Use cents for money in minor units; null means unknown, not zero. You can also author tables directly using tables:[{title,basis,explanation,columns:[label],rows:[[value]]}]. Direct values are labeled by their basis; a claimed actual without an evidence binding is labeled unverified, not discarded.",example:{layout:"grid",panels:[{ref:"q1",kind:"bar",x:"category",y:"amount_cents"}]}},
};
// The upstream default template advertises Card, demo data, repeat, /state
// and mutable actions. Our data-bound registry does not execute those. Use
// JSON Render's documented promptTemplate hook and its own schema formatter
// so Luna receives exactly the available components and valid native syntax.
const catalog=defineCatalog(defineSchema(()=>schema.definition,{promptTemplate:({options,formatZodType})=>[
 options.system,
 "Write normal Markdown. To insert a visual at the current position, emit a spec fenced block containing native RFC 6902 JSONL patches; then continue the answer. A text-only answer is appropriate when no visual improves it.",
 "Example of native syntax (references and field names must come from your actual evidence):",
 String.fromCharCode(96).repeat(3)+"spec",
 JSON.stringify({op:"add",path:"/root",value:"view"}),
 JSON.stringify({op:"add",path:"/elements/view",value:{type:"DataView",props:components.DataView.example,children:[]}}),
 String.fromCharCode(96).repeat(3),
 "Each independent view starts its own spec fence. Only /root and /elements are supported. Stack can contain DataView children; DataView is a leaf. No repeat, executable actions or arbitrary client code. Model-authored calculations, forecasts and explicitly labeled hypothetical scenarios are supported.",
 ...Object.entries(components).map(([name,c])=>name+": "+formatZodType(c.props)+" — "+c.description),
 ...(options.customRules??[]),
].filter(Boolean).join("\n")}),{components,actions:{}});
export const INLINE_PRESENTATION_HINT=catalog.prompt({mode:"inline",
 system:"You are composing the actual owner-facing answer. Use natural Markdown together with the available visual and interactive components whenever they make the answer clearer. Choose the representation yourself; the information source does not determine the layout. Prefer a visual over a Markdown table whenever the answer has figures across several periods or items, a ranking, a comparison or headline numbers: a chart for trends, a table for records, metric cards for the key figures, with a short sentence of prose around it. Use direct model-authored panels for calculations, forecasts and scenarios when helpful; distinguish actual records from assumptions and estimates. Choose prose or visuals independently of the retrieval method.",
 customRules:["Use separate spec fences for independent UI sections anywhere in the answer; continue ordinary prose between them. Use the presentationRef from admitted tool results or the text references described in the turn context. Bind existing values when convenient, or author panels and tables directly for any answer. Source confidence is a label, not a condition for display. Explain the basis and do not represent assumptions as actual business records. Historical messages are prior claims, not fresh business evidence. No generic executable actions."]});
type Selection=z.infer<typeof selection>;
export type PresentationContext={asOf:string;currency?:string|null;presentationAttachments?:readonly string[]};
type Context=PresentationContext;
type Row=Record<string,unknown>;
export type PresentationEvidence={data:Row;source:string;kind?:"sql"|"calculator";coverage?:"partial"|"estimate";text?:string};
export type PresentationEvidenceMap=ReadonlyMap<string,PresentationEvidence>;
const obj=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const name=(key:string)=>key.replaceAll("_"," ").trim().slice(0,140);
const visible=(key:string)=>!/(?:^|[._])(?:id|ref|email|phone|password|secret|credential|token|authorization|cookie)(?:$|[._])/iu.test(key)&&!/(?:Id|Ref|Token|Secret|Password|Credential|Email|Phone|Cookie)$/u.test(key)&&!["__proto__","prototype","constructor"].includes(key);
const unit=(key:string)=>/(?:^|_)cents$|Cents$/u.test(key)?"cents":/(?:^|_)(?:count|orders|quantity)$|(?:Count|Orders|Quantity)$/u.test(key)?"count":"stored";
const rawCell=(v:unknown)=>v===null||["string","boolean","number"].includes(typeof v);
const title=(s:Selection,fallback:string)=>descriptiveGroupTitle(s.title)?.slice(0,140)||fallback||"Query results";

function table(s:Selection,rows:Row[],ctx:Context,e:PresentationEvidence):RecordTable|null{
 const keys=s.columns??[s.x,s.y].filter((v):v is string=>typeof v==="string");
 if(!keys.length||keys.some(k=>!visible(k)))return null;
 const columns=keys.map(k=>({label:name(k),unit:unit(k)==="cents"&&rows.every(r=>r[k]==null||typeof r[k]==="number")?"cents":unit(k)==="count"&&rows.every(r=>r[k]==null||typeof r[k]==="number")?"count":"stored"}));
 const result=recordTableSchema.safeParse({title:title(s,"Query results"),view:e.kind==="sql"?"tool_sql_research":"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
  currency:ctx.currency??null,coverage:e.coverage?"partial":"stored",
  scope:(e.source+"; see the answer for period and coverage").slice(0,300),
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
  from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,source:e.kind==="sql"?"sql_research":"response_evidence",sourceDetail:e.source.slice(0,500),coverage:e.coverage,
  ...(chartUnit==="units"?{measurement:name(y).slice(0,80)}:{}),points:typed});
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
  inputs:inputs.map(i=>obj(i)?{id:i.name,label:name(String(i.name)),value:shown(i.value,i.unit),editable:editable.includes(String(i.name))&&i.unit!=="ratio"}:null),
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
  const source=evidence.get(item.value.ref);
  if(!source)return null;
  const bound=bindValue(source,item.value,ctx);
  if(!bound)return null;
  const labelSource=item.labelField?evidence.get(item.labelField.ref):undefined;
  const label=item.labelField?(labelSource&&item.labelField.path?safeLabel(field(labelSource.data,item.labelField.path)):undefined):
   descriptiveGroupTitle(item.label);
  if(!label)return null;
  values.push({...bound,label,source});
 }
 const first=values[0];
 if(values.some(v=>v.unit!==first.unit||v.measurement!==first.measurement)||new Set(values.map(v=>v.label)).size!==values.length)return null;
 const coverage=values.some(v=>v.source.coverage==="partial")?"partial":values.some(v=>v.source.coverage==="estimate")?"estimate":undefined;
 const sourceDetail=[...new Set(values.map(v=>v.source.source))].join("; ").slice(0,500);
 const result=presentationPanelSchema.safeParse({kind:s.kind,title:descriptiveGroupTitle(s.title)??"Comparison",
  unit:first.unit,currency:first.unit==="cents"?ctx.currency??null:null,from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
  source:"response_evidence",sourceDetail,coverage,...(first.measurement?{measurement:first.measurement}:{}),
  points:values.map(({label,value})=>({label,value}))});
 return result.success?result.data:null;
}

/** Bind a selected component to the existing validated presentation blocks. */
export function resolveResearchView(raw:unknown,queries:PresentationEvidenceMap,ctx?:Context):RichPresentation|undefined{
 if(!obj(raw)||!ctx)return;
 const panels:PresentationPanel[]=[],tables:RecordTable[]=[];
 const layout=raw.layout==="grid"?"grid":"stack";
 const c=calcSelection.safeParse(raw.calculator);
 const authored=directCalc.safeParse(raw.calculator);
 const calculated=authored.success?calculator({...calculate(authored.data),calculationInput:authored.data},authored.data.editable,ctx):null;
 const calc=c.success?calculator(queries.get(c.data.ref)?.data??{},c.data.editable,ctx):calculated&&{...calculated,title:safeLabel(authored.success?authored.data.title??"What-if calculation":"What-if calculation")??"What-if calculation"};
 for(const value of Array.isArray(raw.panels)?raw.panels:[]){
  const direct=analysisPanel.safeParse(value);
  if(direct.success){
   const a=direct.data;
   const heading=safeLabel(a.title??"Luna analysis")??"Luna analysis";
   const coverage=a.basis==="estimate"||a.basis==="scenario"?"estimate":a.basis==="calculated"?undefined:"unverified";
   const detail="Luna "+(a.basis==="calculated"?"calculation (model-derived)":a.basis==="scenario"?"hypothetical scenario":a.basis==="estimate"?"estimate":"unverified statement")+(a.explanation?": "+a.explanation:"");
   const points=a.points.map(p=>({label:safeLabel(p.label)??"Value",value:p.value}));
   const currency=["cents","cents/hour"].includes(a.unit)?ctx.currency??null:null;
   const modelPanel=presentationPanelSchema.safeParse({kind:a.kind,title:heading,unit:a.unit,currency,from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
     source:"response_evidence",sourceDetail:detail,coverage,...(a.measurement?{measurement:a.measurement}:{}),points});
   if(modelPanel.success)panels.push(modelPanel.data);
   else{
    const numeric=points.every(p=>p.value===null||typeof p.value==="number");
    const fallback=recordTableSchema.safeParse({title:heading,view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency,
     coverage:coverage??"unverified",scope:detail,columns:[{label:"Category",unit:"label"},{label:a.measurement??a.unit,unit:numeric?a.unit:"stored"}],
     rows:points.map(p=>[p.label,p.value])});
    if(fallback.success)tables.push(fallback.data);
   }
   continue;
  }
  const selectedPoints=pointPanel.safeParse(value);
  if(selectedPoints.success){const p=pointView(selectedPoints.data,queries,ctx);if(p)panels.push(p);continue;}
  const s=selection.safeParse(value);if(!s.success)continue;
  const e=queries.get(s.data.ref),q=e?.data;
  if(!e||!q||q.ok===false||q.error||!Array.isArray(q.rows)||!q.rows.length||!q.rows.every(obj))continue;
  if(s.data.kind==="table"){
   const t=table(s.data,q.rows,ctx,e);if(t)tables.push(t);
  }else{
   const p=panel(s.data,q.rows,ctx,e);
   if(p)panels.push(p);
   else {const t=table(s.data,q.rows,ctx,e);if(t)tables.push(t);}
  }
 }
 for(const rawTable of Array.isArray(raw.tables)?raw.tables:[]){
  const t=authoredTable.safeParse(rawTable);if(!t.success)continue;
  const a=t.data, width=Math.max(a.columns.length,...a.rows.map(r=>r.length));
  const columns=Array.from({length:width},(_,i)=>({label:a.columns[i]??"Value "+(i+1),unit:"stored"}));
  const result=recordTableSchema.safeParse({title:a.title??"Luna analysis",view:"tool_response_evidence",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,currency:ctx.currency??null,
   coverage:a.basis==="estimate"||a.basis==="scenario"?"estimate":"unverified",scope:"Luna "+(a.basis??"unverified")+(a.explanation?": "+a.explanation:""),
   columns,rows:a.rows.map(row=>Array.from({length:width},(_,i)=>row[i]??null))});
  if(result.success)tables.push(result.data);
 }
 const attachments=raw.files===true?[...new Set(ctx.presentationAttachments??[])].slice(0,3):[];
 const block=recoverRichPresentation({type:"rich_presentation",version:1,layout,panels,suggestions:[],
  ...(tables.length?{tables}:{}),...(calc?{calculator:calc}:{}),...(raw.report===true?{report:true}:{}),...(attachments.length?{files:attachments}:{})});
 return block;
}

/** Apply only data-only element tree patches, using the installed library's
 * compiler. Never execute model-supplied actions, state bindings or unsafe paths.
 * Resolve each view independently so a malformed sibling cannot erase prose. */
export function resolveResearchSpec(patches:readonly unknown[],queries:PresentationEvidenceMap,ctx?:Context):RichPresentation[]{
 const compiler=createSpecStreamCompiler();
 const safeKey=(s:string)=>/^[a-zA-Z0-9_-]+$/u.test(s)&&!["__proto__","constructor","prototype"].includes(s);
 const safeValue=(v:unknown):boolean=>Array.isArray(v)?v.every(safeValue):!obj(v)||Object.entries(v).every(([k,x])=>!["__proto__","constructor","prototype"].includes(k)&&safeValue(x));
 for(const value of patches){
  if(!obj(value)||typeof value.path!=="string"||!["add","replace","remove"].includes(String(value.op))||!safeValue(value.value))continue;
  const parts=value.path.split("/").slice(1);
  if(value.path!=="/root"&&(parts[0]!=="elements"||parts.slice(1).some(k=>!safeKey(k))))continue;
  try{compiler.push(JSON.stringify(value as unknown as SpecStreamLine)+"\n");}catch{/* Invalid patch is display-only. */}
 }
 let spec:ReturnType<typeof compiler.getResult>;
 try{spec=compiler.getResult();}catch{return [];}
 if(typeof spec.root!=="string"||!obj(spec.elements))return [];
 const visited=new Set<string>(),result:RichPresentation[]=[];
 const walk=(key:string)=>{
  if(visited.has(key)||!safeKey(key))return;
  visited.add(key);
  const element=Object.hasOwn(spec.elements as Row,key)?(spec.elements as Row)[key]:null;
  if(!obj(element))return;
  if(element.type==="DataView"){
   const view=resolveResearchView(element.props,queries,ctx);if(view)result.push(view);
  }else if(element.type==="Stack"&&Array.isArray(element.children)){
   for(const child of element.children)if(typeof child==="string")walk(child);
  }
 };
 walk(spec.root);
 return result;
}
