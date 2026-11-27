import {createJsonRenderTransform,type StreamChunk} from "@json-render/core";
type ProviderEvent={type:string;[key:string]:unknown};
const obj=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const tick=String.fromCharCode(96).repeat(3);
const escapeKey=(key:string)=>key.replace(/~/g,"~0").replace(/\//g,"~1");

/** Equivalent serializations enter the same upstream compiler. Ordinary JSON
 * examples and unrecognized/malformed fences are retained as authored text. */
function normalizeFence(open:string,body:string,close:string):string{
 const lang=open.trim().slice(3).trim().toLowerCase();
 if(lang!=="spec"&&lang!=="json")return open+body+close;
 let value:unknown;try{value=JSON.parse(body);}catch{return open+body+close;}
 let patches:unknown[]|undefined;
 if(obj(value)&&typeof value.root==="string"&&obj(value.elements)&&Object.hasOwn(value.elements,value.root)){
  patches=[{op:"add",path:"/root",value:value.root},...Object.entries(value.elements).map(([key,node])=>({op:"add",path:"/elements/"+escapeKey(key),value:node})),...(value.state===undefined?[]:[{op:"add",path:"/state",value:value.state}])];
 }else if(Array.isArray(value)&&value.length&&value.every(p=>obj(p)&&typeof p.op==="string"&&typeof p.path==="string")&&value.some(p=>p.path==="/root")){
  patches=value;
 }
 return patches?tick+"spec\n"+patches.map(p=>JSON.stringify(p)).join("\n")+"\n"+close:open+body+close;
}

/** Buffer only code fences and an unfinished line. No model or answer
 * validation: normalize equivalent data encodings before upstream parsing. */
class FenceAdapter{
 private pending="";
 private open="";
 private body="";
 private fenceLength=0;
 push(delta:string,final=false):string[]{
  this.pending+=delta;const out:string[]=[];
  for(;;){
   const newline=this.pending.indexOf("\n");
   if(newline<0&&(!final||!this.pending))break;
   const line=newline<0?this.pending:this.pending.slice(0,newline+1);
   this.pending=this.pending.slice(line.length);
   if(this.open){
    const closing=/^[ \t]*(`{3,})[ \t]*\r?\n?$/u.exec(line);
    if(closing&&closing[1].length>=this.fenceLength){out.push(normalizeFence(this.open,this.body,line));this.open="";this.body="";this.fenceLength=0;}
    else this.body+=line;
   }else{
    const opening=/^[ \t]*(`{3,})[^`\r\n]*\r?\n?$/u.exec(line);
    if(opening){this.open=line;this.fenceLength=opening[1].length;}else out.push(line);
   }
  }
  if(final&&this.open){out.push(this.open+this.body);this.open="";this.body="";}
  return out;
 }
}
function messageText(item:unknown):string|null{
 if(!obj(item)||item.type!=="message"||item.role!=="assistant"||!Array.isArray(item.content))return null;
 const parts=item.content.filter(p=>obj(p)&&p.type==="output_text"&&typeof p.text==="string");
 return parts.length?parts.map(p=>p.text as string).join(""):null;
}
function completedText(response:unknown):string|null{
 if(!obj(response)||!Array.isArray(response.output))return null;
 const parts=response.output.map(messageText).filter((v):v is string=>v!==null);
 return parts.length?parts.join(""):null;
}

/** Adapt Responses transport to the native transform. Reconcile authoritative
 * completed message text, including suffixes missing from the delta stream. */
export async function* researchInlineEvents(events:AsyncIterable<ProviderEvent>):AsyncGenerator<ProviderEvent>{
 async function* input():AsyncGenerator<StreamChunk>{
  const adapter=new FenceAdapter();let received="";const completedMessages:string[]=[];
  const completedParts=new Map<string,string>();
  function* chunks(delta:string):Generator<StreamChunk>{
   if(!delta)return;
   yield {type:"aicafe-raw",delta};
   yield {type:"text-delta",id:"1",delta};
   yield {type:"aicafe-boundary"};
  }
  for await(const event of events){
   if(event.type==="response.output_text.delta"&&typeof event.delta==="string"){
    received+=event.delta;
    for(const part of adapter.push(event.delta))yield* chunks(part);
   }else{
    if(event.type==="response.output_text.done"&&typeof event.text==="string"){
     const key=String(event.output_index??event.item_id??0)+":"+String(event.content_index??0);completedParts.set(key,event.text);
    }
    if(event.type==="response.output_item.done"){
     const message=messageText(event.item);if(message!==null)completedMessages.push(message);
    }
    if(event.type==="response.completed"){
     const final=completedText(event.response)??(completedMessages.length?completedMessages.join(""):completedParts.size?[...completedParts.values()].join(""):null);
     if(final!==null&&final.startsWith(received)){
      for(const part of adapter.push(final.slice(received.length),true))yield* chunks(part);
     }else{
      for(const part of adapter.push("",true))yield* chunks(part);
     }
     yield {type:"text-end",id:"1"};
     if(final!==null&&!final.startsWith(received))yield {type:"aicafe-provider",event:{type:"inline-reconcile",text:final}};
    }
    yield {type:"aicafe-provider",event};
   }
  }
 }
 const iterator=input();
 const source=new ReadableStream<StreamChunk>({
  async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){controller.error(error);}},
  async cancel(){await iterator.return(undefined);}
 });
 const reader=source.pipeThrough(createJsonRenderTransform()).getReader();
 let text="";
 try{
  for(;;){
   const next=await reader.read();if(next.done)break;
   const item=next.value;
   if(item.type==="text-delta"&&typeof item.delta==="string"){text+=item.delta;continue;}
   if(text){yield {type:"inline-text",delta:text};text="";}
   if(item.type==="data-spec"){
    const d=item.data as {type?:unknown;patch?:unknown}|undefined;
    if(d?.type==="patch")yield {type:"inline-patch",patch:d.patch};
   }else if(item.type==="aicafe-raw")yield {type:"raw-delta",delta:item.delta};
   else if(item.type==="aicafe-provider")yield item.event as ProviderEvent;
  }
  if(text)yield {type:"inline-text",delta:text};
 }finally{
  await reader.cancel().catch(()=>undefined);reader.releaseLock();
 }
}
