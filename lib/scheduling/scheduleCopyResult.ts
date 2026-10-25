/** Turn a protected sendSchedule result into copy-ready text; this does not send messages. */
type SendResult={ok:true;data:{messages:{text:string}[]}}|{ok:false;error?:string};
export async function safeScheduleCopyResponse(send:()=>Promise<SendResult>):Promise<{ok:true;copy:string}|{ok:false}>{
 try{
  const result=await send();
  if(!result.ok)return {ok:false};
  const copy=result.data.messages.map(message=>message.text).filter(text=>text.trim().length>0).join("\n");
  return copy?{ok:true,copy}:{ok:false};
 }catch{return {ok:false};}
}
