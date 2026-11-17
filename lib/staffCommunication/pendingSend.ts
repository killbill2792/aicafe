/** A single browser-tab outbox record. The database deduplicates by worker + nonce.
 * Never replace an ambiguous send with a new nonce, response code or text. */
export type PendingCrewSubmission={
 requestId:string|null;
 response:"confirm"|"decline"|"complete"|"message"|"report";
 body:string|null;
 nonce:string;
};
export type CrewSubmissionReceipt={id:string;replayed:boolean};
export type CrewDeliveryResult={status:"confirmed";receipt:CrewSubmissionReceipt}|{status:"stale_request"}|{status:"unconfirmed"};
export type CrewOutboxStorage={
 getItem(key:string):string|null;
 setItem(key:string,value:string):void;
 removeItem(key:string):void;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const responses=new Set(["confirm","decline","complete","message","report"]);
export function crewOutboxKey(authUserId:string):string{
 return "aicafe:crew:pending:v1:"+authUserId;
}
export function crewRejectedDraftKey(authUserId:string):string{
 return "aicafe:crew:rejected-draft:v1:"+authUserId;
}
export function parseCrewPending(raw:string|null):PendingCrewSubmission|null{
 if(!raw)return null;
 try{
  const v:unknown=JSON.parse(raw);
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const p=v as Record<string,unknown>;
  if(typeof p.nonce!=="string"||!uuid.test(p.nonce))return null;
  if(p.requestId!==null&&(typeof p.requestId!=="string"||!uuid.test(p.requestId)))return null;
  if(typeof p.response!=="string"||!responses.has(p.response))return null;
  if(p.body!==null&&(typeof p.body!=="string"||p.body.length>2000))return null;
  if((p.response==="report")!==(p.requestId===null))return null;
  if(["message","report"].includes(p.response)&&(!p.body||typeof p.body!=="string"))return null;
  return {requestId:p.requestId,response:p.response as PendingCrewSubmission["response"],
   body:p.body as string|null,nonce:p.nonce};
 }catch{return null;}
}
export function loadCrewPending(storage:CrewOutboxStorage,key:string):PendingCrewSubmission|null{
 return parseCrewPending(storage.getItem(key));
}
export function saveCrewPending(storage:CrewOutboxStorage,key:string,p:PendingCrewSubmission):void{
 storage.setItem(key,JSON.stringify(p));
}
export function sameCrewOperation(current:PendingCrewSubmission|null,
 proposed:PendingCrewSubmission):PendingCrewSubmission{
 return current??proposed;
}
/** Bounded automatic retry: no new submission identity after lost HTTP ack.
 * An unconfirmed record remains in the tab's outbox until a real RPC receipt.
 * The UI keeps it visible and permits retry with the same identity later. */
export async function deliverCrewWithRetry(
 pending:Readonly<PendingCrewSubmission>,
 post:(value:Readonly<PendingCrewSubmission>)=>Promise<unknown>,
 pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
):Promise<CrewDeliveryResult>{
 for(let i=0;i<3;i++){
  try{
   const value=await post(pending);
   if(value&&typeof value==="object"&&!Array.isArray(value)){
    const receipt=value as Record<string,unknown>;
    // Only the server's explicit stale_request code is definitive; generic
    // 409, invalid response, lost HTTP ack and nonce_conflict remain uncertain.
    if(receipt.error==="stale_request")return {status:"stale_request"};
    if(typeof receipt.id==="string"&&uuid.test(receipt.id)&&
      typeof receipt.replayed==="boolean")
     return {status:"confirmed",receipt:{id:receipt.id,replayed:receipt.replayed}};
   }
  }catch{/* Network/HTTP receipt is uncertain. Keep the identical operation. */}
  if(i<2)await pause([400,1200][i]);
 }
 return {status:"unconfirmed"};
}
