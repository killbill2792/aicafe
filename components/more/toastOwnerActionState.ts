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
