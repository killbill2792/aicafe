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
