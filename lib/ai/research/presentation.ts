import {z} from "zod";
import {presentationPanelSchema,recordTableSchema,richPresentationSchema,descriptiveGroupTitle,interactiveCalcSchema,evaluatePresentationCalc,type InteractiveCalc,type PresentationPanel,type RecordTable,type RichPresentation} from "@/lib/ai/conversations/presentation";

/** Optional selections inside ordinary model output. Use the same renderer and
 * stored block as every other Supervisor answer. No query, model call or effect
 * is executed here; values come only from successful same-turn SQL results. */
export const SQL_PRESENTATION_HINT=
 "Answer naturally in Markdown. When useful, you can append a cafe-ui fenced JSON block to the same answer: "+
 '{"layout":"grid","panels":[{"ref":"q1","kind":"bar","x":"category","y":"amount_cents"}],"report":true}. '+
 "Use presentationRef from successful run_sql results and their exact column aliases. Kinds: metric, bar, line, donut, ranked_table, table (columns array for a multi-column table). "+
 "Use descriptive titles if needed. You can select multiple panels, a downloadable report or selected files, or a local what-if calculator with calculator:{ref,editable:[input names]} from calculate. This is optional; no need to repeat values in the JSON.";
const selection=z.object({
 ref:z.string(),kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 x:z.string().optional(),y:z.string().optional(),columns:z.array(z.string()).optional(),title:z.string().optional(),
});
const envelope=z.object({layout:z.enum(["stack","grid"]).optional(),panels:z.array(z.unknown()).optional(),
 report:z.boolean().optional(),files:z.boolean().optional(),calculator:z.object({ref:z.string(),editable:z.array(z.string())}).optional()});
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

/** Parse only the optional fenced UI selection, not the answer itself. Bad
 * selections cannot discard valid siblings or any ordinary Markdown. */
export function splitResearchPresentation(raw:string,queries:ReadonlyMap<string,Row>,ctx?:Context):{text:string;presentation?:RichPresentation}{
 const panels:PresentationPanel[]=[],tables:RecordTable[]=[];
 let layout:"stack"|"grid"="stack",report=false,files=false;
 let calc:InteractiveCalc|null=null;
 const text=raw.replace(/^[ \t]*\x60{3}cafe-ui[ \t]*\r?\n[\s\S]*?(?:^[ \t]*\x60{3}[ \t]*(?=\r?$)|$(?![\s\S]))/gmu,block=>{
  try{
   const body=block.replace(/^[ \t]*\x60{3}cafe-ui[ \t]*\r?\n/u,"").replace(/\r?\n[ \t]*\x60{3}[ \t]*$/u,"");
   const parsed=envelope.safeParse(JSON.parse(body));
   if(!parsed.success||!ctx)return "";
   layout=parsed.data.layout??layout;report=report||parsed.data.report===true;files=files||parsed.data.files===true;
   if(parsed.data.calculator){const q=queries.get(parsed.data.calculator.ref);if(q)calc=calculator(q,parsed.data.calculator.editable,ctx)??calc;}
   for(const value of parsed.data.panels??[]){
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
  }catch{/* Optional presentation has no bearing on the natural answer. */}
  return "";
 });
 const attachments=files?[...new Set(ctx?.presentationAttachments??[])].slice(0,3):[];
 const block=richPresentationSchema.safeParse({type:"rich_presentation",version:1,layout,panels,suggestions:[],
  ...(tables.length?{tables}:{}),...(calc?{calculator:calc}:{}),...(report?{report:true}:{}),...(attachments.length?{files:attachments}:{})});
 return {text:text.trim(),...(block.success?{presentation:block.data}:{})};
}
