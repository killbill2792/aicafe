import { createStateStore,type Spec,type StateStore } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";
import {normalizeTableData} from "./tableFormatting";
import {adaptDisplayProperties} from "./displayPropCompatibility";
import { CALC_OPS,exactDecimal,runCalculation,type CalcUnit } from "@/lib/metrics/core/calculator";

/** Import the complete installed public web catalog; never maintain a copied
 * inventory. The same upstream definitions generate model instructions and
 * describe the registry on the client. Our domain components are additions. */
export const upstreamComponents={...shadcnComponentDefinitions,Grid:{...shadcnComponentDefinitions.Grid,description:"Adaptive grid. Columns is a preferred count, not a fixed or maximum count; omit it for content-driven wrapping. The renderer fits the authored content to available space."}};
export const nativeChartProps=z.object({
 kind:z.enum(["metric","bar","line","donut","ranked_table","table"]),
 title:z.string(),unit:z.enum(["cents","count","items","units","seconds","minutes","hours","days","ratio","ratio squared","indicator","cents/hour"]),
 currency:z.string().nullable().default(null),measurement:z.string().optional(),description:z.string().optional(),asOf:z.iso.date().optional(),
 points:z.array(z.object({label:z.string(),value:z.number().finite().nullable()})).min(1),
});
export const nativeChartDefinition={props:nativeChartProps,slots:[],description:"Luna financial charts and metrics. Use local state bindings or calculated values in points; monetary values are in minor units."};
// A future library release must not silently acquire network or business-action authority.
const approvedLocalActions=new Set(["setState","pushState","removeState","validateForm"]);
export const localActionNames=new Set((schema.builtInActions??[]).map(a=>a.name).filter(name=>approvedLocalActions.has(name)));
const obj=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
const forbidden=new Set(["__proto__","prototype","constructor"]);
export const safeKey=(s:string)=>s.length>0&&!forbidden.has(s);
const decodeSegment=(s:string)=>s.replace(/~1/g,"/").replace(/~0/g,"~");
export const safeStatePath=(path:unknown):path is string=>typeof path==="string"&&path.split("/").every(p=>{const key=decodeSegment(p);return !forbidden.has(key)&&!/^0[0-9]+$/.test(key);});
/** Only JSON data crosses the boundary, not functions, browser objects or
 * prototype-mutating keys. Iterative traversal has no arbitrary layout depth. */
export function safeNativeJSON(value:unknown):boolean{
 const pending=[value],seen=new Set<object>();
 while(pending.length){
  const v=pending.pop();
  if(v===null||typeof v==="string"||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v))continue;
  if(!v||typeof v!=="object"||seen.has(v))return false;
  seen.add(v);
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)return false;
  for(const [key,child] of Object.entries(v)){
   if(!safeKey(key))return false;
   if(["$state","$bindState","$item","$bindItem","openPath","clearStatePath"].includes(key)&&!safeStatePath(child))return false;
   if(key==="$computed"&&child!=="calculate"&&child!=="format")return false;
   pending.push(child);
  }
 }
 return true;
}
function allowedBinding(raw:unknown):boolean{
 const pending=Array.isArray(raw)?[...raw]:[raw];
 while(pending.length){
  const a=pending.pop();if(!obj(a)||typeof a.action!=="string"||!localActionNames.has(a.action))return false;
  if(a.params!==undefined&&!obj(a.params))return false;
  for(const k of ["onSuccess","onError"]){
   const after=a[k];if(after===undefined)continue;
   if(!obj(after)||Object.hasOwn(after,"navigate"))return false;
   if(Object.hasOwn(after,"action"))pending.push(after);
   else if(!obj(after.set)||!Object.keys(after.set).every(safeStatePath))return false;
  }
 }
 return true;
}
function watchTargets(raw:unknown):string[]|null{
 const pending=Array.isArray(raw)?[...raw]:[raw],targets:string[]=[];
 while(pending.length){
  const a=pending.pop();if(!obj(a))return null;
  const p=obj(a.params)?a.params:{};
  const target=p.statePath??(a.action==="validateForm"?"/formValidation":undefined);
  if(!safeStatePath(target)||!target.startsWith("/")||target==="/")return null;
  targets.push(target);
  if(p.clearStatePath!==undefined){if(!safeStatePath(p.clearStatePath)||!p.clearStatePath.startsWith("/")||p.clearStatePath==="/")return null;targets.push(p.clearStatePath);}
  for(const k of ["onSuccess","onError"]){const after=a[k];if(obj(after)){if(obj(after.set)){const keys=Object.keys(after.set);if(keys.some(k=>!safeStatePath(k)||!k.startsWith("/")||k==="/"))return null;targets.push(...keys);}if(after.action)pending.push(after);}}
 }
 return targets;
}
const canonicalPath=(path:string)=>path.split("/").slice(1).map(decodeSegment).map(s=>s.replace(/~/g,"~0").replace(/\//g,"~1")).join("/");
const overlap=(a:string,b:string)=>{const x=canonicalPath(a),y=canonicalPath(b);return x===y||x.startsWith(y+"/")||y.startsWith(x+"/");};
/** An interactive spec may have arbitrary acyclic layout depth. State is local
 * to a single message; only upstream local state actions may run. Watch
 * dependencies must be acyclic so an automatic effect cannot spin forever. */
export function validNativeSpec(raw:unknown):raw is Spec{
 if(!safeNativeJSON(raw)||!obj(raw)||typeof raw.root!=="string"||!safeKey(raw.root)||!obj(raw.elements)||!Object.hasOwn(raw.elements,raw.root)||raw.state!==undefined&&!obj(raw.state))return false;
 const elements=raw.elements,seen=new Set<string>(),pending=[raw.root],watches:{path:string;targets:string[]}[]=[];
 while(pending.length){
  const key=pending.pop()!;if(seen.has(key)||!Object.hasOwn(elements,key))return false;seen.add(key);
  const e=elements[key];if(!obj(e)||typeof e.type!=="string"||!safeKey(e.type)||!obj(e.props))return false;
  if(!Object.hasOwn(upstreamComponents,e.type)&&e.type!=="LunaChart"&&e.type!=="LunaSnapshot"&&e.type!=="LunaFallback")return false;
  if(e.type==="LunaSnapshot"){
   if(typeof e.props.snapshotJSON!=="string")return false;
   try{const snapshot:unknown=JSON.parse(e.props.snapshotJSON);if(!obj(snapshot)||snapshot.type!=="rich_presentation"||snapshot.version!==1||Object.hasOwn(snapshot,"nativeSpec")||!safeNativeJSON(snapshot))return false;}catch{return false;}
  }
  const children=e.children??[];if(!Array.isArray(children)||children.some(k=>typeof k!=="string"||!safeKey(k)))return false;
  pending.push(...children);
  if(e.slots!==undefined){
   if(!obj(e.slots))return false;
   for(const children of Object.values(e.slots)){if(!Array.isArray(children)||children.some(k=>typeof k!=="string"||!safeKey(k)))return false;pending.push(...children);}
  }
  if(e.repeat!==undefined){if(!obj(e.repeat))return false;const path=e.repeat.statePath;if(!safeStatePath(path)&&!(obj(path)&&safeStatePath(path.$item)))return false;}
  if(e.on!==undefined&&(!obj(e.on)||!Object.values(e.on).every(allowedBinding)))return false;
  if(e.watch!==undefined){
   if(!obj(e.watch))return false;
   for(const [path,binding] of Object.entries(e.watch)){
    if(!safeStatePath(path)||!path.startsWith("/")||path==="/"||!allowedBinding(binding))return false;
    const targets=watchTargets(binding);if(!targets)return false;watches.push({path,targets});
   }
  }
 }
 if(seen.size!==Object.keys(elements).length)return false;
 const edges=watches.map(w=>watches.flatMap((other,i)=>w.targets.some(t=>overlap(t,other.path))?[i]:[]));
 const indegree=watches.map(()=>0);for(const next of edges)for(const i of next)indegree[i]++;
 const queue=indegree.flatMap((n,i)=>n===0?[i]:[]);let checked=0;
 while(queue.length){const i=queue.pop()!;checked++;for(const j of edges[i])if(--indegree[j]===0)queue.push(j);}
 return checked===watches.length;
}
export const nativeSpecSchema=z.custom<Spec>(validNativeSpec);
/** An unknown component is not a reason to suppress its data or its siblings.
 * Prefer the installed widget; otherwise use an inert data-only component.
 * No action from an unknown component receives execution authority. */
export function recoverNativeDisplaySpec(raw:unknown):Spec|undefined{
 if(!obj(raw)||!obj(raw.elements)||!safeNativeJSON(raw))return;
 if(validNativeSpec(raw))return raw;
 const source=raw.elements,keys=Object.keys(source);
 if(!keys.length)return;
 const elements:Record<string,Record<string,unknown>>={};
 const visited=new Set<string>(),roots:string[]=[];
 // Traverse each authored node once, preserve its first layout position, and
 // attach disconnected nodes rather than dropping them with a broken parent.
 const attach=(value:unknown):string[]=>{
  if(!Array.isArray(value))return [];
  return value.filter((key):key is string=>{
   if(typeof key!=="string"||!Object.hasOwn(source,key)||visited.has(key))return false;
   visited.add(key);return true;
  });
 };
 for(const root of [raw.root,...keys]){
  const next=attach([root]);if(!next.length)continue;
  roots.push(next[0]);const pending=[next[0]];
  while(pending.length){
   const key=pending.shift()!,item=source[key],e=obj(item)?item:{props:item};
   const children=attach(e.children);
   const slots=obj(e.slots)?Object.fromEntries(Object.entries(e.slots).map(([slot,items])=>[slot,attach(items)])):{};
   pending.push(...children,...Object.values(slots).flat());
   const type=e.type;
   const known=typeof type==="string"&&(Object.hasOwn(upstreamComponents,type)||["LunaChart","LunaSnapshot","LunaFallback"].includes(type))&&obj(e.props);
   const element:Record<string,unknown>=known?{type,props:e.props}:{type:"LunaFallback",props:{widget:String(type??"Visual"),values:e.props??{}}};
   element.children=children;
   if(Object.keys(slots).length)element.slots=slots;
   if(e.visible!==undefined)element.visible=e.visible;
   if(obj(e.repeat)&&(safeStatePath(e.repeat.statePath)||obj(e.repeat.statePath)&&safeStatePath(e.repeat.statePath.$item)))element.repeat=e.repeat;
   // Invalid or unknown controls cannot acquire execution authority, but all
   // their authored props remain displayable. Safe existing controls survive.
   if(known&&obj(e.on)){
    const on=Object.fromEntries(Object.entries(e.on).filter(([,binding])=>allowedBinding(binding)));
    if(Object.keys(on).length)element.on=on;
   }
   if(known&&obj(e.watch)){
    const watch=Object.fromEntries(Object.entries(e.watch).filter(([path,binding])=>safeStatePath(path)&&path.startsWith("/")&&path!=="/"&&allowedBinding(binding)&&watchTargets(binding)!==null));
    if(Object.keys(watch).length)element.watch=watch;
   }
   elements[key]=element;
  }
 }
 let root=roots[0];
 if(roots.length>1){root="luna-recovered-root";while(Object.hasOwn(elements,root))root+="-";elements[root]={type:"Stack",props:{},children:roots};}
 const candidate={root,elements,...(obj(raw.state)?{state:raw.state}:{})};
 if(validNativeSpec(candidate))return candidate;
 // A cross-node watch cycle may remain. Disable automatic execution rather
 // than suppressing the authored information or otherwise safe interactions.
 for(const element of Object.values(elements))delete element.watch;
 return validNativeSpec(candidate)?candidate:undefined;
}
/** Opaque snapshots cannot be interpreted as state expressions. */
export function readNativeSnapshot(value:unknown):unknown{try{return typeof value==="string"?JSON.parse(value):undefined;}catch{return undefined;}}
/** Wrap the library store, not the components. Dynamic bindings and actions
 * cannot write into app state, navigate, call APIs or mutate a prototype. */
export function createLocalWidgetStore(state:Record<string,unknown>={}):StateStore{
 const base=createStateStore(safeNativeJSON(state)?state:{});
 const safeWrite=(path:string,value:unknown)=>safeStatePath(path)&&path.startsWith("/")&&path!=="/"&&(value===undefined||safeNativeJSON(value));
 return {...base,get:path=>safeStatePath(path)?base.get(path):undefined,
  set:(path,value)=>{if(safeWrite(path,value))base.set(path,value);},
  update:updates=>base.update(Object.fromEntries(Object.entries(updates).filter(([path,value])=>safeWrite(path,value))))};
}
/** Runtime URL and style boundary covers state-resolved props, including
 * components added in a future dependency release. No automatic remote image
 * request may leak business data. Existing authenticated attachment controls
 * remain the way to show owner files. External HTTPS links are user-clicked. */
export function nativeRenderProps(props:Record<string,unknown>):Record<string,unknown>{
 const cleaned:Record<string,unknown>={};
 for(const [key,value] of Object.entries(props)){
  if(!safeKey(key)||/^on[A-Z]/.test(key)||key==="dangerouslySetInnerHTML"||key==="style")continue;
  if(/^(?:src|srcSet|poster|imageUrl|backgroundImage)$/i.test(key)){
   cleaned[key]=typeof value==="string"&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)?value:null;continue;
  }
  if(/^(?:href|url|action|formAction)$/i.test(key)){
   try{const url=new URL(String(value));cleaned[key]=url.protocol==="https:"&&!url.username&&!url.password?url.href:"#";}catch{cleaned[key]="#";}continue;
  }
  if(key==="className"){cleaned[key]=typeof value==="string"?value.split(/\s+/).filter(v=>/^[a-z0-9:_/-]+$/i.test(v)&&!/(?:^|:)(?:fixed|absolute|sticky|inset-|z-)/.test(v)).join(" "):null;continue;}
  cleaned[key]=value;
 }
 return cleaned;
}
/** Validate resolved values against the installed prop schema, including
 * upstream's nullable default convention. */
export function parseUpstreamProps(name:string,props:Record<string,unknown>){
 if(!Object.hasOwn(upstreamComponents,name))return;
 const definition=upstreamComponents[name as keyof typeof upstreamComponents];
 const values=nativeRenderProps(props);
 // Upstream Table expects display strings. Preserve actual scalar cells,
 // including state-bound numbers, zero, negatives, booleans and unknowns.
 // This is data formatting for the official component, not a widget copy.
 if(name==="Table"&&Array.isArray(values.rows)){
  const table=normalizeTableData(values.columns,values.rows);
  values.columns=table.columns;
  values.rows=table.rows.map(row=>row.map(value=>value===null?"Not recorded":String(value)));
 }
 const adapted=adaptDisplayProperties(definition.props,values);
 return definition.props.safeParse(adapted);
}
const calcInput=z.object({name:z.string(),unit:z.enum(["cents","count","percent","ratio"]),value:z.union([z.string(),z.number().finite()])});
const calcArgs=z.object({inputs:z.array(calcInput),steps:z.array(z.object({id:z.string(),op:z.enum(CALC_OPS),args:z.array(z.string())})),format:z.enum(["number","currency","percent"]).optional(),currency:z.string().optional()});
/** One exact existing arithmetic engine is available to any native prop;
 * no JS eval, no database access, and no new financial formula catalog. */
export const nativeFunctions={
 calculate:(args:Record<string,unknown>):unknown=>{
  const parsed=calcArgs.safeParse(args);if(!parsed.success)return null;
  const {inputs,steps,format,currency}=parsed.data;
  const entries=new Map<string,NonNullable<ReturnType<typeof exactDecimal>>>();
  for(const i of inputs){const v=exactDecimal(String(i.value),i.unit as CalcUnit,i.unit==="percent"?100:1);if(!v||entries.has(i.name))return null;entries.set(i.name,v);}
  const result=runCalculation(entries,steps);if(!result.ok)return null;
  const v=result.result.shown;
  const n=v.unit==="cents"?v.valueCents:v.unit==="percent"?v.valueBps/100:v.unit==="count"?v.quantity:v.valueRatio;
  if(format==="currency")try{return new Intl.NumberFormat(undefined,{style:"currency",currency:currency??""}).format(n/100);}catch{return null;}
  return format==="percent"?n+"%":n;
 },
 format:(args:Record<string,unknown>):unknown=>{
  const value=args.value;if(typeof value!=="number"||!Number.isFinite(value))return value??null;
  try{return new Intl.NumberFormat(undefined,typeof args.currency==="string"?{style:"currency",currency:args.currency}:{maximumFractionDigits:6}).format(typeof args.currency==="string"?value/100:value);}catch{return String(value);}
 },
};
