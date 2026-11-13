import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {decryptToken,encryptToken} from "@/lib/connectors/crypto.server";
import {getConnectorAccount,assertGmailCapability,type ConnectorOwner,type ConnectorOperation,type ConnectorAccount} from "@/lib/connectors/registry.server";
import {tokenRequest,GOOGLE_MODIFY_SCOPE} from "./oauth.server";

export type GmailAuthorized={account:ConnectorAccount;token:string};
export async function authorizedGmail(scope:ConnectorOwner,operation:ConnectorOperation):Promise<GmailAuthorized>{
  const account=await getConnectorAccount(scope);
  assertGmailCapability(account,operation);
  const db=createAdminSupabaseClient();
  const {data:secret,error}=await db.from("connector_credentials")
    .select("access_token_enc,refresh_token_enc,token_expires_at").eq("account_id",account.id).maybeSingle();
  if(error||!secret)throw new Error("gmail_reconnect_required");
  const expiry=Date.parse(secret.token_expires_at);
  if(!Number.isFinite(expiry))throw new Error("gmail_reconnect_required");
  if(expiry>Date.now()+60000)return {account,token:decryptToken(secret.access_token_enc)};
  let refreshed;
  try{refreshed=await tokenRequest({grant_type:"refresh_token",refresh_token:decryptToken(secret.refresh_token_enc)});}
  catch{
    await db.from("connector_accounts").update({status:"needs_reconnect",generation:account.generation+1,updated_at:new Date().toISOString()})
      .eq("id",account.id).eq("generation",account.generation).eq("status","active");
    throw new Error("gmail_reconnect_required");
  }
  const updated=await db.from("connector_credentials").update({
    access_token_enc:encryptToken(refreshed.access_token),
    refresh_token_enc:refreshed.refresh_token?encryptToken(refreshed.refresh_token):secret.refresh_token_enc,
    token_expires_at:new Date(Date.now()+refreshed.expires_in*1000).toISOString(),
    updated_at:new Date().toISOString(),
  }).eq("account_id",account.id);
  if(updated.error)throw new Error("gmail_refresh_save_failed");
  // A concurrent owner disconnect may have invalidated the refreshed credentials.
  const still=await getConnectorAccount(scope);
  if(still?.id!==account.id||still?.generation!==account.generation||still.status!=="active")
    throw new Error("gmail_connection_changed");
  return {account,token:refreshed.access_token};
}
export async function gmailApi(token:string,path:string,init?:{method?:"GET"|"POST"|"PUT"|"DELETE";body?:unknown}):Promise<unknown>{
  if(!path.startsWith("/")||path.startsWith("//"))throw new Error("invalid_gmail_path");
  const response=await fetch("https://gmail.googleapis.com/gmail/v1/users/me"+path,{
    method:init?.method??"GET",headers:{authorization:"Bearer "+token,
      ...(init?.body===undefined?{}:{"content-type":"application/json"})},
    ...(init?.body===undefined?{}:{body:JSON.stringify(init.body)}),
    cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(response.status===401?"gmail_reconnect_required":"gmail_provider_request_failed");
  return response.status===204?null:response.json();
}
export type GmailMessage={id:string;threadId?:string;snippet?:string;internalDate?:string;
  payload?:{headers?:Array<{name:string;value:string}>;mimeType?:string;body?:{data?:string;size?:number};
    parts?:Array<{mimeType?:string;filename?:string;body?:{data?:string;attachmentId?:string;size?:number}}>};
  labelIds?:string[]};
export function safeMessage(message:GmailMessage){
  const headers=Object.fromEntries((message.payload?.headers??[])
    .filter(h=>/^(from|to|cc|subject|date|message-id)$/i.test(h.name))
    .map(h=>[h.name.toLowerCase(),h.value.slice(0,500)]));
  const plainParts=[...(message.payload?.mimeType==="text/plain"&&message.payload.body?.data?
    [message.payload.body.data]:[]),...(message.payload?.parts??[])
    .filter(p=>p.mimeType==="text/plain"&&p.body?.data).map(p=>p.body!.data!)];
  const body=plainParts.slice(0,3).map(encoded=>{
    try{return Buffer.from(encoded,"base64url").toString("utf8");}catch{return "";}
  }).join("\n").slice(0,12000);
  const attachments=(message.payload?.parts??[])
    .filter(p=>Boolean(p.filename&&p.body?.attachmentId)).slice(0,20)
    .map(p=>({filename:p.filename!.slice(0,180),size:p.body!.size??null,attachmentId:p.body!.attachmentId}));
  return {id:message.id,threadId:message.threadId??null,headers,body,
    snippet:message.snippet?.slice(0,400)??"",receivedAt:message.internalDate?
      new Date(Number(message.internalDate)).toISOString():null,labels:message.labelIds??[],attachments};
}
export async function gmailSearch(scope:ConnectorOwner,query:string,limit=12){
  const {token,account}=await authorizedGmail(scope,"read");
  const params=new URLSearchParams({maxResults:String(Math.max(1,Math.min(20,limit))),q:query.slice(0,200)});
  const list=await gmailApi(token,"/messages?"+params) as {messages?:Array<{id:string;threadId:string}>;resultSizeEstimate?:number};
  const messages=await Promise.all((list.messages??[]).slice(0,20).map(async m=>{
    const msg=await gmailApi(token,"/messages/"+encodeURIComponent(m.id)+"?format=full") as GmailMessage;
    return safeMessage(msg);
  }));
  return {account:account.email,source:"gmail",asOf:new Date().toISOString(),messages:messages.map(m=>({
    id:m.id,threadId:m.threadId,headers:m.headers,snippet:m.snippet,receivedAt:m.receivedAt,attachments:m.attachments}))};
}
export async function gmailRead(scope:ConnectorOwner,messageId:string){
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(messageId))throw new Error("gmail_invalid_message_id");
  const {token,account}=await authorizedGmail(scope,"read");
  const message=await gmailApi(token,"/messages/"+encodeURIComponent(messageId)+"?format=full") as GmailMessage;
  return {account:account.email,source:"gmail",asOf:new Date().toISOString(),message:safeMessage(message)};
}
export {GOOGLE_MODIFY_SCOPE};

/** A send receipt must be durable BEFORE the provider request starts. Gmail has no
 * documented application idempotency key; uncertain responses are never retried. */
export type GmailEffect={accountId:string;generation:number;from:string;
  operation:"send"|"draft"|"modify"|"trash"|"restore"|"create_label";
  action:"mark_read"|"mark_unread"|"star"|"unstar"|"archive"|"unarchive"|"add_label"|"remove_label"|null;
  to:string[];cc:string[];bcc:string[];subject:string;body:string;
  messageId:string|null;threadId:string|null;labelId:string|null;labelName:string|null};
const header=(value:string)=>value.replace(/[\r\n]+/g," ").slice(0,1000);
const subjectHeader=(value:string)=>"=?UTF-8?B?"+Buffer.from(header(value),"utf8").toString("base64")+"?=";
export function gmailRfcId(proposalId:string,mailbox:string):string{
  const domain=mailbox.split("@").at(-1);
  if(!domain||!/^[a-z\d.-]+$/i.test(domain)||!/^[a-f\d-]{36}$/i.test(proposalId))
    throw new Error("gmail_invalid_receipt_identity");
  return "<aicafe-"+proposalId+"@"+domain+">";
}
export function gmailMime(effect:GmailEffect,rfcId:string,referenceId:string|null):string{
  const lines=["From: "+header(effect.from),"To: "+effect.to.map(header).join(", "),
    ...(effect.cc.length?["Cc: "+effect.cc.map(header).join(", ")]:[]),
    ...(effect.bcc.length?["Bcc: "+effect.bcc.map(header).join(", ")]:[]),
    "Subject: "+subjectHeader(effect.subject),"Message-ID: "+rfcId,
    ...(referenceId?["In-Reply-To: "+referenceId,"References: "+referenceId]:[]),
    "MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",
    Buffer.from(effect.body,"utf8").toString("base64")];
  return Buffer.from(lines.join("\r\n"),"utf8").toString("base64url");
}
function labelChanges(e:GmailEffect):{addLabelIds:string[];removeLabelIds:string[]}{
  const add:string[]=[],remove:string[]=[];
  const addActions:{[key:string]:string}={mark_unread:"UNREAD",star:"STARRED",unarchive:"INBOX"};
  const removeActions:{[key:string]:string}={mark_read:"UNREAD",unstar:"STARRED",archive:"INBOX"};
  if(e.action&&e.action in addActions)add.push(addActions[e.action]);
  if(e.action&&e.action in removeActions)remove.push(removeActions[e.action]);
  if(e.action==="add_label"&&e.labelId)add.push(e.labelId);
  if(e.action==="remove_label"&&e.labelId)remove.push(e.labelId);
  if(add.length+remove.length!==1)throw new Error("gmail_invalid_label_operation");
  return {addLabelIds:add,removeLabelIds:remove};
}
function headersOf(msg:GmailMessage){return Object.fromEntries((msg.payload?.headers??[])
  .map(h=>[h.name.toLowerCase(),h.value]));}
async function verifyReceipt(token:string,e:GmailEffect,returnedId:string,rfc:string|null):Promise<{messageId:string;threadId:string|null}>{
  if(e.operation==="create_label")return {messageId:returnedId,threadId:null};
  if(e.operation==="draft"){
    const draft=await gmailApi(token,"/drafts/"+encodeURIComponent(returnedId)) as {id?:string;message?:GmailMessage};
    if(draft.id!==returnedId||!draft.message?.id)throw new Error("gmail_draft_receipt_unverified");
    return {messageId:returnedId,threadId:draft.message.threadId??null};
  }
  const msg=await gmailApi(token,"/messages/"+encodeURIComponent(returnedId)+"?format=metadata") as GmailMessage;
  if(msg.id!==returnedId)throw new Error("gmail_message_receipt_unverified");
  if(e.operation==="send"&&(!msg.labelIds?.includes("SENT")||headersOf(msg)["message-id"]!==rfc))
    throw new Error("gmail_send_receipt_unverified");
  if(e.operation==="trash"&&!msg.labelIds?.includes("TRASH"))throw new Error("gmail_trash_receipt_unverified");
  if(e.operation==="restore"&&msg.labelIds?.includes("TRASH"))throw new Error("gmail_restore_receipt_unverified");
  if(e.operation==="modify"){
    const change=labelChanges(e);
    if(change.addLabelIds.some(x=>!msg.labelIds?.includes(x))||
       change.removeLabelIds.some(x=>msg.labelIds?.includes(x)))throw new Error("gmail_modify_receipt_unverified");
  }
  return {messageId:returnedId,threadId:msg.threadId??null};
}
export async function performGmailEffect(scope:ConnectorOwner,effect:GmailEffect,proposalId:string,effectHash:string){
  const required:ConnectorOperation=effect.operation==="send"?"send":effect.operation==="draft"?"draft":"organize";
  const {token,account}=await authorizedGmail(scope,required);
  if(account.id!==effect.accountId||account.generation!==effect.generation||
    account.email.toLowerCase()!==effect.from.toLowerCase())throw new Error("gmail_connection_changed");
  const db=createAdminSupabaseClient();
  const rfc=effect.operation==="send"?gmailRfcId(proposalId,effect.from):null;
  const receipt={account_id:account.id,business_id:scope.businessId,owner_user_id:scope.ownerUserId,
    proposal_id:proposalId,effect_hash:effectHash,account_generation:account.generation,
    operation:effect.operation,rfc_message_id:rfc,state:"pending"};
  const inserted=await db.from("connector_provider_receipts").insert(receipt).select("id").maybeSingle();
  if(inserted.error||!inserted.data){
    // A previously reserved send might already have reached Gmail. Never invoke it again.
    throw new Error("gmail_effect_already_reserved_reconcile_first");
  }
  let response:{id?:string;threadId?:string};
  let returnedId:string;
  let referenceId:string|null=null;
  let verifiedThreadId:string|null=null;
  if(effect.operation==="send"||effect.operation==="draft"){
    if(effect.messageId){
      const source=await gmailApi(token,"/messages/"+encodeURIComponent(effect.messageId)+"?format=metadata") as GmailMessage;
      if(!source.id||!source.threadId)throw new Error("gmail_reply_source_unavailable");
      if(effect.threadId&&effect.threadId!==source.threadId)throw new Error("gmail_reply_thread_mismatch");
      verifiedThreadId=source.threadId;
      referenceId=headersOf(source)["message-id"]??null;
      if(referenceId&&(!/^<[^<>\r\n]{1,240}>$/.test(referenceId)))throw new Error("gmail_reply_header_untrusted");
    }
    const raw=gmailMime(effect,rfc??gmailRfcId(proposalId,effect.from),referenceId);
    const threadId=effect.messageId?verifiedThreadId:effect.threadId;
    if(effect.operation==="send"){
      const live=await getConnectorAccount(scope);
      if(live?.status!=="active"||live.id!==account.id||live.generation!==account.generation)
        throw new Error("gmail_connection_revoked_before_send");
      response=await gmailApi(token,"/messages/send",{method:"POST",body:{
        raw,...(threadId?{threadId}:{})}}) as {id?:string;threadId?:string};
    }else{
      response=await gmailApi(token,"/drafts",{method:"POST",body:{message:{
        raw,...(threadId?{threadId}:{})}}}) as {id?:string;threadId?:string};
    }
  }else if(effect.operation==="create_label"){
    response=await gmailApi(token,"/labels",{method:"POST",body:{
      name:effect.labelName,labelListVisibility:"labelShow",messageListVisibility:"show"}}) as {id?:string};
  }else{
    if(!effect.messageId)throw new Error("gmail_message_required");
    const id=encodeURIComponent(effect.messageId);
    if(effect.operation==="trash")response=await gmailApi(token,"/messages/"+id+"/trash",{method:"POST"}) as {id?:string};
    else if(effect.operation==="restore")response=await gmailApi(token,"/messages/"+id+"/untrash",{method:"POST"}) as {id?:string};
    else response=await gmailApi(token,"/messages/"+id+"/modify",{method:"POST",body:labelChanges(effect)}) as {id?:string};
  }
  returnedId=response?.id??"";
  if(!returnedId)throw new Error("gmail_provider_receipt_missing");
  const checked=await verifyReceipt(token,effect,returnedId,rfc);
  const updated=await db.from("connector_provider_receipts").update({
    state:"verified",provider_message_id:checked.messageId,
    provider_thread_id:checked.threadId,provider_accepted_at:new Date().toISOString(),
    updated_at:new Date().toISOString()
  }).eq("id",inserted.data.id).eq("state","pending").select("id").maybeSingle();
  if(updated.error||!updated.data)throw new Error("gmail_receipt_save_failed");
  return {providerId:checked.messageId,providerAccepted:true,recipientDeliveryUnverified:true};
}
/** Read-only reconciliation: an uncertain Gmail send is NEVER resent, even when
 * a search returns no match. Absence is not proof of non-delivery. */
export async function reconcileGmailReceipt(scope:ConnectorOwner,effect:GmailEffect,proposalId:string,effectHash:string):Promise<boolean>{
  const db=createAdminSupabaseClient();
  const {data:record,error}=await db.from("connector_provider_receipts").select("*")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("proposal_id",proposalId).eq("effect_hash",effectHash).maybeSingle();
  if(error||!record||record.account_id!==effect.accountId||record.account_generation!==effect.generation)return false;
  if(record.state==="verified"&&record.provider_message_id)return true;
  if(effect.operation!=="send"||!record.rfc_message_id)return false;
  let token:string;
  try{({token}=await authorizedGmail(scope,"read"));}catch{return false;}
  const q="rfc822msgid:"+record.rfc_message_id;
  const found=await gmailApi(token,"/messages?"+new URLSearchParams({q,maxResults:"10"})) as {messages?:Array<{id:string}>};
  for(const candidate of found.messages??[]){
    const msg=await gmailApi(token,"/messages/"+encodeURIComponent(candidate.id)+"?format=metadata") as GmailMessage;
    if(msg.labelIds?.includes("SENT")&&headersOf(msg)["message-id"]===record.rfc_message_id){
      const saved=await db.from("connector_provider_receipts").update({
        state:"verified",provider_message_id:msg.id,provider_thread_id:msg.threadId??null,
        provider_accepted_at:new Date().toISOString(),updated_at:new Date().toISOString()
      }).eq("id",record.id).in("state",["pending","uncertain"]).select("id").maybeSingle();
      return !saved.error&&Boolean(saved.data);
    }
  }
  return false;
}
