import "server-only";
import {createElement,type ReactNode,type ComponentType} from "react";
import type {Spec,UIElement} from "@json-render/core";
import {standardComponents,renderToBuffer,type RenderComponentRegistry} from "@json-render/react-pdf/render";
import {standardComponentDefinitions} from "@json-render/react-pdf/server";
import {normalizeTableData} from "./tableFormatting";
import {presentationDataLines,presentationReport,recoverRichPresentation,type RichPresentation} from "./presentation";
import {safeNativeJSON} from "./nativePresentation";
import {z} from "zod";

type SavedMessage=Parameters<typeof presentationReport>[1];
const obj=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const display=(value:unknown)=>value==null?"Not recorded":typeof value==="string"?value:typeof value==="object"?JSON.stringify(value):String(value);

/** This guard protects server execution, not answer delivery. A malformed
 * graph always has the same saved-content PDF/text fallback. */
export function executablePdfSpec(raw:unknown):Spec|undefined{
 if(!obj(raw)||!safeNativeJSON(raw)||typeof raw.root!=="string"||!obj(raw.elements)||raw.state!==undefined&&!obj(raw.state))return;
 const elements=raw.elements,root=elements[raw.root];
 if(!obj(root)||root.type!=="Document"||!Array.isArray(root.children)||!root.children.length)return;
 if(root.children.some(key=>{const child=typeof key==="string"?elements[key]:undefined;return !obj(child)||child.type!=="Page";}))return;
 const seen=new Set<string>(),pending=[raw.root];
 while(pending.length){
  const key=pending.pop()!,e=elements[key];
  if(seen.has(key)||!Object.hasOwn(elements,key)||!obj(e)||typeof e.type!=="string"||!Object.hasOwn(standardComponentDefinitions,e.type)||!obj(e.props))return;
  seen.add(key);
  const children=e.children??[];
  if(!Array.isArray(children)||children.some(child=>typeof child!=="string"))return;
  if(e.slots!==undefined)return; // The installed PDF renderer traverses children.
  pending.push(...children);
 }
 if(seen.size!==Object.keys(elements).length)return;
 return raw as unknown as Spec;
}

/** Wrap the complete official registry. Normalize resolved values at the
 * last possible point, including values bound through state and repeat. */
export function pdfRenderProps(name:string,raw:Record<string,unknown>):Record<string,unknown>{
 const definition=standardComponentDefinitions[name as keyof typeof standardComponentDefinitions];
 if(!definition)throw Error("pdf_component_unavailable");
 const fields=definition.props.shape as Record<string,z.ZodType>;
 const props:Record<string,unknown>={};
 for(const key of Object.keys(fields))if(Object.hasOwn(raw,key))props[key]=raw[key];
 if(name==="Table"&&Array.isArray(props.rows)){
  const columns=Array.isArray(props.columns)?props.columns:[];
  const labels=columns.map(col=>obj(col)?col.header:col);
  const table=normalizeTableData(labels,props.rows);
  props.columns=table.columns.map((header,index)=>{const original=columns[index];return {...(obj(original)?original:{}),header};});
  props.rows=table.rows.map(row=>row.map(display));
 }
 if(name==="List"&&Array.isArray(props.items))props.items=props.items.map(display);
 if(name==="Image"){
  // The PDF renderer otherwise fetches arbitrary URLs and local files.
  if(typeof props.src!=="string"||!/^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(props.src))throw Error("pdf_image_unavailable");
 }
 if(name==="Link"){
  if(typeof props.href!=="string")throw Error("pdf_link_unavailable");
  const url=new URL(props.href);
  if(url.protocol!=="https:"||url.username||url.password)throw Error("pdf_link_unavailable");
 }
 for(const [key,field] of Object.entries(fields)){
  if(!Object.hasOwn(props,key)){if(field.safeParse(null).success)props[key]=null;continue;}
  const value=props[key];if(field.safeParse(value).success)continue;
  const candidates=typeof value==="number"||typeof value==="boolean"?[String(value)]:typeof value==="string"&&value.trim()?[
   ...(/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(value)&&Number.isFinite(Number(value))?[Number(value)]:[]),
   ...(value==="true"||value==="false"?[value==="true"]:[])
  ]:[];
  for(const candidate of candidates)if(field.safeParse(candidate).success){props[key]=candidate;break;}
 }
 const parsed=definition.props.safeParse(props);
 if(!parsed.success)throw Error("pdf_props_unavailable");
 return parsed.data as Record<string,unknown>;
}

function registry():RenderComponentRegistry{
 const result:RenderComponentRegistry={};
 for(const [name,Component] of Object.entries(standardComponents)){
  result[name]=(input:{element:UIElement;children?:ReactNode;emit:()=>void})=>createElement(Component as ComponentType<typeof input>,{...input,element:{...input.element,props:pdfRenderProps(name,input.element.props)}});
 }
 return result;
}

/** Construct a readable PDF from the existing saved-answer snapshot. Use the
 * official PDF components for tables and text; no analytical recomputation. */
export function savedAnswerPdfSpec(message:SavedMessage,blocks:RichPresentation[]):Spec{
 const elements:Spec["elements"]={doc:{type:"Document",props:{title:"Luna report",author:"AI Cafe"},children:["page"]},page:{type:"Page",props:{size:"LETTER",marginTop:40,marginBottom:40,marginLeft:40,marginRight:40},children:[]}};
 let count=0;
 const add=(type:string,props:Record<string,unknown>)=>{const key="item"+(++count);elements[key]={type,props,children:[]};elements.page.children!.push(key);};
 add("Heading",{text:"Luna report",level:"h1"});
 // Reuse the original answer text/cautions, then add each presentation once.
 const text= presentationReport({type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[]},message);
 for(const line of text.split(/\n/u)){
  const heading=/^#{1,6}\s+(.*)$/u.exec(line);
  if(heading)add("Heading",{text:heading[1],level:"h2"});else if(line)add("Text",{text:line,fontSize:10,lineHeight:1.4});else add("Spacer",{height:6});
 }
 for(const block of blocks){
  const rest={...block,tables:undefined};
  for(const line of presentationDataLines(rest))if(line)add("Text",{text:line,fontSize:10,lineHeight:1.4});
  for(const table of block.tables??[]){
   add("Heading",{text:table.title,level:"h2"});
   if(table.scope)add("Text",{text:table.scope,fontSize:10});
   add("Text",{text:"Period: "+table.from+" – "+table.to+"; snapshot: "+table.asOf+(table.currency?" ("+table.currency+")":""),fontSize:9});
   add("Table",{columns:table.columns.map(c=>({header:c.label+(c.unit==="stored"||c.unit==="label"?"":" ("+c.unit+")")})),rows:table.rows.map(row=>row.map(display)),fontSize:9,striped:true});
  }
 }
 return {root:"doc",elements};
}

export function reportBlocks(message:SavedMessage):RichPresentation[]{
 return (message.blocks??[]).flatMap(raw=>{const block=recoverRichPresentation(raw);return block?[block]:[];});
}

export async function renderSavedAnswerPdf(message:SavedMessage,selected?:RichPresentation):Promise<Uint8Array>{
 const blocks=selected?[selected]:reportBlocks(message);
 if(selected?.pdfSpec){
  const spec=executablePdfSpec(selected.pdfSpec);
  if(spec)try{return await renderToBuffer(spec,{registry:registry(),includeStandard:false});}catch{/* Preserve the saved content using the same official renderer. */}
 }
 return renderToBuffer(savedAnswerPdfSpec(message,blocks),{registry:registry(),includeStandard:false});
}
