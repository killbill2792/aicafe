/** One event contract shared by the Toast credentials form and owner status.
 * Do not tie status refreshes to component mount order.
 */
export const TOAST_CONNECTION_CHANGED = "toast-connection-changed";
export function subscribeToastConnectionChanges(target:EventTarget,onChange:()=>void){
 target.addEventListener(TOAST_CONNECTION_CHANGED,onChange);
 return ()=>target.removeEventListener(TOAST_CONNECTION_CHANGED,onChange);
}

/** A credential change or explicit retry supersedes any slower in-flight read. */
export function createToastStatusRequestGate(){
 let current=0;
 return {
  begin:()=>++current,
  isCurrent:(request:number)=>request===current,
  invalidate:()=>{current++;}
 };
}
