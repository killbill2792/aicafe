import {proposalRequestKey} from "./requestKeys";

/** Stable per-line idempotency across retries; a different batch is not the same retry. */
export function purchaseBatchKeys(threadId:string,ownerMessageId:string,source:string,lines:readonly unknown[]){
 return lines.map((line,index)=>proposalRequestKey(threadId,JSON.stringify({
  ownerMessageId,kind:"purchase",batch:lines,line,source,indexInBatch:index
 })));
}

/** Use the receipt-wide maximum, never an index relative to an individual tool call. */
export function allocateReceiptIndexes(keys:readonly string[],existing:readonly {requestKey:string;index:number|null|undefined}[]){
 const known=new Map(existing.filter(x=>x.index!==null&&x.index!==undefined).map(x=>[x.requestKey,x.index!] as const));
 let next=Math.max(-1,...Array.from(known.values()))+1;
 return keys.map(key=>{
  const previous=known.get(key);
  if(previous!==undefined)return previous;
  const index=next++;
  known.set(key,index);
  return index;
 });
}
