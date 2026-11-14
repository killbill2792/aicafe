import {createHash} from "node:crypto";
import {proposalRequestKey} from "./requestKeys";

/** Stable receipt-line idempotency is independent of model call boundaries
 * and ordering. Duplicate physically identical lines in ONE call receive
 * distinct occurrence identities; a repeat in a later call resolves to the
 * first existing identity rather than silently creating another stock entry.
 * A truly separate matching line in a later call needs owner review because
 * the model did not supply verifiable physical source-row identity.
 */
export function purchaseBatchKeys(threadId:string,ownerMessageId:string,source:string,lines:readonly unknown[]){
 const occurrences=new Map<string,number>();
 return lines.map(line=>{
  // Tool inputs are schema-validated before this helper is called.
  const data=line as {ingredientId?:string|null;name?:string;quantity?:number;
   unit?:string;costCents?:number|null;date?:string};
  const text=(value:string|undefined)=>(value??"").normalize("NFKC").trim()
   .toLocaleLowerCase().replace(/\s+/gu," ");
  const fingerprint=JSON.stringify({
   ingredient:data.ingredientId??text(data.name),quantity:data.quantity,
   unit:text(data.unit),costCents:data.costCents??null,date:data.date
  });
  const occurrence=occurrences.get(fingerprint)??0;
  occurrences.set(fingerprint,occurrence+1);
  return proposalRequestKey(threadId,JSON.stringify({
   ownerMessageId,kind:"purchase",source,fingerprint,occurrence
  }));
 });
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

/** One stable source identity across repeat uploads of byte-identical evidence.
 * The original bytes never leave private storage except the authenticated read. */
export function receiptEvidenceGroupId(businessId:string,ownerId:string,contentSha256:string):string{
 const hex=createHash("sha256").update("aicafe-receipt-evidence-v1:")
  .update(businessId).update(":").update(ownerId).update(":").update(contentSha256)
  .digest("hex").slice(0,32).split("");
 hex[12]="5";hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);
 const id=hex.join("");
 return [id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join("-");
}
/** Same original receipt line is a no-op on retry, never another stock movement. */
export function receiptStockLineId(groupId:string,index:number):string{
 if(!Number.isInteger(index)||index<0||index>=100)throw new Error("invalid_receipt_line_index");
 return receiptEvidenceGroupId(groupId,"line",String(index));
}
