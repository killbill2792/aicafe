import "server-only";
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from "node:crypto";
import {z} from "zod";
import {snapshotExactCalculation,restoreExactCalculation} from "@/lib/ai/agent/tools/calculate";
import type {AgentToolResult} from "@/lib/ai/agent/tools";
import type {RunScope,RestoredResearchRead} from "./contracts";

const researchName=z.enum(["describe_data","query_data","calculate"]);
export const isResearchCheckpointTool=(name:unknown):name is z.infer<typeof researchName>=>researchName.safeParse(name).success;
type Scope=RunScope&{runId:string};
const payload=z.strictObject({
 version:z.literal(1),name:researchName,arguments:z.string(),
 result:z.looseObject({source:z.string(),period:z.looseObject({from:z.string(),to:z.string()}).nullable(),
  missing:z.array(z.string()),agentId:z.enum(["alex","olivia","maya","leo"]).optional()}),
 exact:z.unknown()
});
function key(){
 const secret=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!secret||secret.length<24)throw Error("research_checkpoint_key_unavailable");
 // Domain-separated key; no extra deployment secret or reliance on optional
 // POS credentials. This key is never available to the model or SQL role.
 return createHmac("sha256",secret).update("aicafe-owner-research-checkpoint-v1").digest();
}
const aad=(s:Scope,operation:string)=>Buffer.from(JSON.stringify([s.businessId,s.ownerUserId,s.threadId,s.runId,operation]),"utf8");
export function encryptResearchCheckpoint(scope:Scope,operation:string,name:RestoredResearchRead["name"],raw:unknown,result:AgentToolResult){
 const plain=JSON.stringify({version:1,name,arguments:JSON.stringify(raw),result,
  exact:snapshotExactCalculation(result)});
 const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv);
 cipher.setAAD(aad(scope,operation));
 const bytes=Buffer.concat([cipher.update(plain,"utf8"),cipher.final()]);
 return [iv,cipher.getAuthTag(),bytes].map(b=>b.toString("base64url")).join(".");
}
export function decryptResearchCheckpoint(scope:Scope,operation:string,ciphertext:string):RestoredResearchRead{
 try{
  const parts=ciphertext.split(".");
  if(parts.length!==3)throw Error("research_checkpoint_invalid");
  const [iv,tag,bytes]=parts.map(p=>Buffer.from(p,"base64url"));
  if(iv.length!==12||tag.length!==16||!bytes.length)throw Error("research_checkpoint_invalid");
  const cipher=createDecipheriv("aes-256-gcm",key(),iv);
  cipher.setAAD(aad(scope,operation));cipher.setAuthTag(tag);
  const data=payload.parse(JSON.parse(Buffer.concat([cipher.update(bytes),cipher.final()]).toString("utf8")));
  const result:AgentToolResult=data.result;
  restoreExactCalculation(result,data.exact);
  return {ref:operation,name:data.name,arguments:data.arguments,result};
 }catch{
  // Never expose decrypted payload, query, source data, key or crypto errors.
  throw Error("research_checkpoint_invalid");
 }
}
