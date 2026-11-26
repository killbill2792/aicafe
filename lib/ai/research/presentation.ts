import {z} from "zod";
import {defineCatalog,defineSchema,createSpecStreamCompiler,type SpecStreamLine} from "@json-render/core";
import {schema} from "@json-render/react/schema";
import {exactDecimal} from "@/lib/metrics/core/calculator";
import {presentationPanelSchema,recordTableSchema,richPresentationSchema,descriptiveGroupTitle,interactiveCalcSchema,evaluatePresentationCalc,type InteractiveCalc,type PresentationPanel,type RecordTable,type RichPresentation} from "@/lib/ai/conversations/presentation";

/** Native inline GenUI vocabulary. All data values bind to the evidence already
 * admitted to this owner turn, irrespective of its retrieval mechanism. */
const fieldPath=z.array(z.union([z.string().min(1).max(140),z.number().int().nonnegative()])).min(1).max(12);
const reference=z.object({ref:z.string(),path:fieldPath.optional(),quote:z.string().min(1).max(100).optional()}).refine(v=>Boolean(v.path)!==Boolean(v.quote));
const pointSelection=z.object({label:z.string().min(1).max(140),value:reference,labelField:reference.optional()});
const pointPanel=z.object({kind:z.enum(["metric","bar","line","donut","ranked_table"]),title:z.string().optional(),points:z.array(pointSelection).min(1).max(30)});

const selection=z.object({
 ref:z.string(),kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 x:z.string().optional(),y:z.string().optional(),columns:z.array(z.string()).optional(),title:z.string().optional(),
});
const calcSelection=z.object({ref:z.string(),editable:z.array(z.string())});
const envelope=z.object({layout:z.enum(["stack","grid"]).optional(),panels:z.array(z.union([selection,pointPanel])).optional(),
 report:z.boolean().optional(),files:z.boolean().optional(),calculator:calcSelection.optional()});
// Reuse the native React grammar without the demo catalog's sample-data instructions.
const catalog=defineCatalog(defineSchema(()=>schema.definition),{components:{
 Stack:{props:z.object({}),slots:["default"],description:"Group views in their displayed order.",example:{}},
 DataView:{props:envelope,slots:[],description:"Compose metrics, charts, tables, calculator or report from available evidence. For a result containing rows use ref, x, y or columns. For individual values, including across different sources, use points with label and value:{ref,path:[exact field names and array indices]}; for text evidence use value:{ref,quote:exact numeric token including currency symbol if present}. For dated or numeric category labels use labelField:{ref,path}. A calculate result can supply an editable calculator.",example:{layout:"grid",panels:[{ref:"q1",kind:"bar",x:"category",y:"amount_cents"}]}},
},actions:{}});
export const INLINE_PRESENTATION_HINT=catalog.prompt({mode:"inline",
 system:"You are composing the actual owner-facing answer. Use natural Markdown together with the available visual and interactive components whenever they make the answer clearer. Choose the representation yourself; the information source does not determine the layout.",
 customRules:["Use separate spec fences for independent UI sections anywhere in the answer; continue ordinary prose between them. Use the presentationRef from admitted tool results or the text references described in the turn context. Bind existing values; do not copy entire datasets or invent numbers. Historical messages are prior claims, not fresh business evidence. No sample state or generic executable actions."]});
type Selection=z.infer<typeof selection>;
type Context={asOf:string;currency?:string|null;presentationAttachments?:readonly string[]};
type Row=Record<string,unknown>;
export type PresentationEvidence={data:Row;source:string;coverage?:"partial"|"estimate";text?:string};
export type PresentationEvidenceMap=ReadonlyMap<string,PresentationEvidence>;
const obj=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const name=(key:string)=>key.replaceAll("_"," ").trim().slice(0,140);
const visible=(key:string)=>!/(?:^|[._])(?:id|email|phone|password|secret|credential|token|authorization|cookie)(?:$|[._])|(?:_id|_ref|Id|Ref|Token|Secret|Password|Credential|Email|Phone|Cookie)$/u.test(key)&&!["__proto__","prototype","constructor"].includes(key);
const unit=(key:string)=>/(?:^|_)cents$|Cents$/u.test(key)?"cents":/(?:^|_)(?:count|orders|quantity)$|(?:Count|Orders|Quantity)$/u.test(key)?"count":"stored";
const rawCell=(v:unknown)=>v===null||["string","boolean","number"].includes(typeof v);
const title=(s:Selection,fallback:string)=>descriptiveGroupTitle(s.title)?.slice(0,140)||fallback||"Query results";

function table(s:Selection,rows:Row[],ctx:Context):RecordTable|null{
 const keys=s.columns??[s.x,s.y].filter((v):v is string=>typeof v==="string");
 if(!keys.length||keys.some(k=>!visible(k)||!rows.every(r=>Object.hasOwn(r,k)&&rawCell(r[k]))))return null;
 const columns=keys.map(k=>({label:name(k),unit:unit(k)==="cents"&&ctx.currency?"cents":unit(k)==="count"&&rows.every(r=>r[k]===null||Number.isSafeInteger(r[k]))?"count":"stored"}));
 const result=recordTableSchema.safeParse({title:title(s,"Query results"),view:"tool_sql_research",from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,
  currency:ctx.currency??null,coverage:rows.length>30?"partial":"stored",
  scope:rows.length>30?"First 30 rows of the returned SQL result; see the answer for scope.":"Returned SQL rows; see the answer for period and coverage.",
  columns,rows:rows.slice(0,30).map(r=>keys.map(k=>r[k]))});
 return result.success?result.data:null;
}
function panel(s:Selection,rows:Row[],ctx:Context):PresentationPanel|null{
 if(!s.y||!visible(s.y)||s.x&&!visible(s.x)||rows.length>30)return null;
 const y=s.y,x=s.x;
 if(!x&&rows.length!==1)return null;
 const u=unit(y),currency=u==="cents"?ctx.currency??null:null;
 const chartUnit=u==="cents"?"cents":u==="count"?"count":"units";
 if(u==="cents"&&!currency)return null;
 const points=rows.map(r=>({label:safeLabel(x?r[x]:name(y)),value:r[y]}));
 if(points.some(p=>(typeof p.label!=="string"&&typeof p.label!=="number")||typeof p.value!=="number"||!Number.isFinite(p.value)))return null;
 const typed=points.map(p=>({label:String(p.label),value:p.value as number}));
 if(new Set(typed.map(p=>p.label)).size!==typed.length)return null;
 if(s.kind==="ranked_table")typed.sort((a,b)=>b.value-a.value);
 // The chart is a view of the query, not a claim of complete underlying
 // records. Do not infer missing time buckets or manufacture a denominator.
 if(s.kind==="donut"&&(typed.some(p=>p.value<0)||typed.every(p=>p.value===0)))return null;
 const p=presentationPanelSchema.safeParse({kind:s.kind,title:title(s,name(y)),unit:chartUnit,currency,
  from:ctx.asOf,to:ctx.asOf,asOf:ctx.asOf,source:"sql_research",sourceDetail:"Returned SQL values; see the answer for period and coverage.",
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
 const matches=[...text.matchAll(/(?<![\p{L}\p{N}.,:-])[-+]?(?:[$€£¥]\s*|[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|\s+[A-Z]{3})?(?![\p{L}\p{N}.,:-])/gu)];
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
  const cents=amount.n*100n;if(cents%amount.d!==0n)return;
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
 if(typeof raw!=="number"||!Number.isFinite(raw)||Math.abs(raw)>Number.MAX_SAFE_INTEGER)return;
 const u=unit(key);
 return (u==="cents"||u==="count")&&!Number.isSafeInteger(raw)?undefined:
  {value:raw,unit:u==="stored"?"units":u};
}
function safeLabel(v:unknown):string|undefined{
 if(typeof v!=="string"&&typeof v!=="number")return;
 const s=String(v).trim();
 return s.length>0&&s.length<=140&&!/[\w.-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(s)?s:undefined;
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
 const calc=c.success?calculator(queries.get(c.data.ref)?.data??{},c.data.editable,ctx):null;
 for(const value of Array.isArray(raw.panels)?raw.panels:[]){
  const selectedPoints=pointPanel.safeParse(value);
  if(selectedPoints.success){const p=pointView(selectedPoints.data,queries,ctx);if(p&&panels.length<8)panels.push(p);continue;}
  const s=selection.safeParse(value);if(!s.success)continue;
  const q=queries.get(s.data.ref)?.data;
  if(q?.ok!==true||!Array.isArray(q.rows)||!q.rows.length||!q.rows.every(obj))continue;
  if(s.data.kind==="table"){
   const t=table(s.data,q.rows,ctx);if(t&&tables.length<8)tables.push(t);
  }else{
   const p=panel(s.data,q.rows,ctx);
   if(p&&panels.length<8)panels.push(p);
   else if(tables.length<8){const t=table(s.data,q.rows,ctx);if(t)tables.push(t);}
  }
 }
 const attachments=raw.files===true?[...new Set(ctx.presentationAttachments??[])].slice(0,3):[];
 const block=richPresentationSchema.safeParse({type:"rich_presentation",version:1,layout,panels,suggestions:[],
  ...(tables.length?{tables}:{}),...(calc?{calculator:calc}:{}),...(raw.report===true?{report:true}:{}),...(attachments.length?{files:attachments}:{})});
 return block.success?block.data:undefined;
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
 const spec=compiler.getResult();
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
