/** Client-side affordance only; endpoints independently enforce feature flags and dates. */
export function canStartToastImport(enabled:boolean,busy:boolean,start:string,yesterday:string){
 return enabled&&!busy&&Boolean(start)&&start>="2015-12-02"&&Boolean(yesterday)&&start<=yesterday;
}
export function canRepullToastDay(enabled:boolean,busy:boolean,day:string,yesterday:string,
 queuedRanges:ReadonlyArray<{from:string;to:string}>){
 return enabled&&!busy&&Boolean(yesterday)&&day<=yesterday&&
  !queuedRanges.some(range=>range.from<=day&&range.to>=day);
}

/** A committed write must never be reported as failed just because the
 * follow-up status GET failed. The GET independently displays its retry UI.
 */
export async function commitToastOwnerAction(write:()=>Promise<void>,refresh:()=>Promise<void>){
 await write();
 try{await refresh();return {refreshAvailable:true};}
 catch{return {refreshAvailable:false};}
}

/** Partial multi-request imports must report which dates were actually queued. */
export class PartialToastQueueError extends Error {
 constructor(public readonly resumeFrom:string,public readonly queuedChunks:number){
  super("Toast import was only partially queued");
 }
}
export async function queueToastBackfillChunks(
 start:string,end:string,queue:(from:string,to:string)=>Promise<void>,
 addDays:(day:string,count:number)=>string
){
 let queuedChunks=0;
 for(let from=start;from<=end;){
  const limit=addDays(from,399);
  const to=limit<end?limit:end;
  try{await queue(from,to);}
  catch{throw new PartialToastQueueError(from,queuedChunks);}
  queuedChunks++;
  from=addDays(to,1);
 }
 return queuedChunks;
}

/** What the owner sees after an action: the exact result, never a generic
 * "unable to save". Keys live in the ToastConnect messages. */
export type ToastActionKind="repull"|"first_check"|"flag"|"retry";
export type ToastActionResult={ok:boolean;key:string};
export function toastActionResult(kind:ToastActionKind,status:number,body:unknown):ToastActionResult{
 const b=(body&&typeof body==="object"?body:{}) as {error?:unknown;disabled?:unknown};
 const error=typeof b.error==="string"?b.error:"";
 if(status>=200&&status<300)
  return {ok:true,key:kind==="repull"?"ownerRepullQueued":kind==="flag"?"ownerSaved":kind==="retry"?"ownerQueued":"ownerSaved"};
 if(kind==="first_check"&&error==="already_answered")return {ok:true,key:"ownerAlreadyAnswered"};
 if(b.disabled===true)return {ok:false,key:"ownerImportOff"};
 if(error==="not_ready")return {ok:false,key:"ownerNotReady"};
 if(error==="unverified_locations")return {ok:false,key:"ownerReconnect"};
 if(error==="not_authorized"||error==="not_found"&&status===403)return {ok:false,key:"ownerNotAuthorized"};
 if(error==="invalid_range"||error==="future_day"||error==="invalid_dates")return {ok:false,key:"ownerInvalidDate"};
 if(error==="select_days")return {ok:false,key:"ownerSelectDays"};
 return {ok:false,key:"ownerError"};
}
