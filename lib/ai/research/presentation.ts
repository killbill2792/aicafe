import {z} from "zod";
import {defineCatalog,defineSchema,createSpecStreamCompiler,type SpecStreamLine} from "@json-render/core";
import {schema} from "@json-render/react/schema";
import {presentationPanelSchema,recordTableSchema,richPresentationSchema,descriptiveGroupTitle,interactiveCalcSchema,evaluatePresentationCalc,type InteractiveCalc,type PresentationPanel,type RecordTable,type RichPresentation} from "@/lib/ai/conversations/presentation";

/** Native inline GenUI vocabulary. All actual business values are resolved from
 * the current authenticated tool results, never from model-generated samples. */
const selection=z.object({
 ref:z.string(),kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 x:z.string().optional(),y:z.string().optional(),columns:z.array(z.string()).optional(),title:z.string().optional(),
});
const calcSelection=z.object({ref:z.string(),editable:z.array(z.string())});
const envelope=z.object({layout:z.enum(["stack","grid"]).optional(),panels:z.array(selection).optional(),
 report:z.boolean().optional(),files:z.boolean().optional(),calculator:calcSelection.optional()});
// Reuse the native React grammar without the demo catalog's sample-data instructions.
const catalog=defineCatalog(defineSchema(()=>schema.definition),{components:{
 Stack:{props:z.object({}),slots:["default"],description:"Group views in their displayed order.",example:{}},
 DataView:{props:envelope,slots:[],description:"Show metrics, charts, tables, calculator or report from successful same-turn tool results. Use presentationRef and exact SQL column aliases. A calculate result can supply a calculator with named editable inputs. Can select multiple results in one view.",example:{layout:"grid",panels:[{ref:"q1",kind:"bar",x:"category",y:"amount_cents"}]}},
},actions:{}});
export const SQL_PRESENTATION_HINT=catalog.prompt({mode:"inline",
 system:"Respond naturally in the owner's language, composing Markdown and the available interactive views in the same answer.",
 customRules:["Use separate spec fences for independent UI sections anywhere in the answer; continue normal prose between them. Use only the successful same-turn presentationRef and returned field names. No sample state, invented data, generic actions or repeated dataset values."]});
type Selection=z.infer<typeof selection>;
type Context={asOf:string;currency?:string|null;presentationAttachments?:readonly string[]};
type Row=Record<string,unknown>;
const obj=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const name=(key:string)=>key.replaceAll("_"," ").trim().slice(0,140);
const visible=(key:string)=>!/(?:^|[._])(?:id|email|phone|password|secret|credential|token)(?:$|[._])|(?:_id|_ref)$/iu.test(key);
const unit=(key:string)=>/(?:^|_)cents$/iu.test(key)?"cents":/(?:^|_)(?:count|orders|quantity)$/iu.test(key)?"count":"stored";
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
 const points=rows.map(r=>({label:x?r[x]:name(y),value:r[y]}));
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

/** Bind a selected component to the existing validated presentation blocks. */
export function resolveResearchView(raw:unknown,queries:ReadonlyMap<string,Row>,ctx?:Context):RichPresentation|undefined{
 if(!obj(raw)||!ctx)return;
 const panels:PresentationPanel[]=[],tables:RecordTable[]=[];
 const layout=raw.layout==="grid"?"grid":"stack";
 const c=calcSelection.safeParse(raw.calculator);
 const calc=c.success?calculator(queries.get(c.data.ref)??{},c.data.editable,ctx):null;
 for(const value of Array.isArray(raw.panels)?raw.panels:[]){
  const s=selection.safeParse(value);if(!s.success)continue;
  const q=queries.get(s.data.ref);
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
export function resolveResearchSpec(patches:readonly unknown[],queries:ReadonlyMap<string,Row>,ctx?:Context):RichPresentation[]{
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
