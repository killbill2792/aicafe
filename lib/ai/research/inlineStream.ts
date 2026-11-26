import {createJsonRenderTransform,type StreamChunk} from "@json-render/core";
type ProviderEvent={type:string;[key:string]:unknown};

/** Adapt the existing Responses transport to the library's native text/spec
 * transform, without changing model calls, tools, accounting or SSE transport.
 * Coalesce its character-level output at each incoming provider delta. */
export async function* researchInlineEvents(events:AsyncIterable<ProviderEvent>):AsyncGenerator<ProviderEvent>{
 async function* input():AsyncGenerator<StreamChunk>{
  for await(const event of events){
   if(event.type==="response.output_text.delta"&&typeof event.delta==="string"){
    yield {type:"aicafe-raw",delta:event.delta};
    yield {type:"text-delta",id:"1",delta:event.delta};
    yield {type:"aicafe-boundary"};
   }else{
    if(event.type==="response.completed")yield {type:"text-end",id:"1"};
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
