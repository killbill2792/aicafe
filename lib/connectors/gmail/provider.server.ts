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
  return {account:account.email,source:"gmail",asOf:new Date().toISOString(),messages};
}
export async function gmailRead(scope:ConnectorOwner,messageId:string){
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(messageId))throw new Error("gmail_invalid_message_id");
  const {token,account}=await authorizedGmail(scope,"read");
  const message=await gmailApi(token,"/messages/"+encodeURIComponent(messageId)+"?format=full") as GmailMessage;
  return {account:account.email,source:"gmail",asOf:new Date().toISOString(),message:safeMessage(message)};
}
export {GOOGLE_MODIFY_SCOPE};
