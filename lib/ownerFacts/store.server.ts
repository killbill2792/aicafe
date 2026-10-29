import "server-only";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import type {SavedFact} from "./inject";
export type OwnerFactAnswer={fieldKey:string;value:unknown;unit?:string|null;periodScope?:string|null};
/** Uses the authenticated user's RLS session, never a service-role cross-café lookup. */
export async function loadOwnerFacts(businessId:string):Promise<SavedFact[]>{
 const db=await createServerSupabaseClient();
 const facts:SavedFact[]=[];
 // Supabase/PostgREST may cap one result page; walk every current fact so an
 // old but still authoritative owner answer is never forgotten in a new chat.
 const pageSize=200;
 for(let start=0;;start+=pageSize){
  const {data,error}=await db.from("owner_facts")
   .select("fact_key,value_json,created_at,unit,period_scope")
   .eq("business_id",businessId).is("superseded_at",null)
   .order("fact_key",{ascending:true}).range(start,start+pageSize-1);
  if(error||!data)throw new Error("owner_facts_read_failed");
  facts.push(...data as SavedFact[]);
  if(data.length<pageSize)break;
 }
 return facts;
}
/** SQL RPC versioning and approved write-through are one DB transaction.
 * A false writeThroughApplied means owner_facts is saved, but the shared
 * screen source could not safely be updated (e.g. already-itemized bills). */
export async function saveOwnerFact(businessId:string,answer:OwnerFactAnswer):Promise<{id:string;writeThroughApplied:boolean}>{
 const db=await createServerSupabaseClient();
 const {data,error}=await db.rpc("save_owner_fact",{
  p_business_id:businessId,p_fact_key:answer.fieldKey,
  p_value_json:answer.value,p_unit:answer.unit??null,p_period_scope:answer.periodScope??null});
 if(error||!data||typeof data!=="object")throw new Error("owner_facts_write_failed");
 const result=data as {id?:unknown;writeThroughApplied?:unknown};
 if(typeof result.id!=="string")throw new Error("owner_facts_write_failed");
 return {id:result.id,writeThroughApplied:result.writeThroughApplied===true};
}

export async function saveOwnerFactAnswers(businessId:string,answers:readonly OwnerFactAnswer[]):
 Promise<{id:string;writeThroughApplied:boolean}[]>{
 const db=await createServerSupabaseClient();
 const {data,error}=await db.rpc("save_owner_fact_answers",{
  p_business_id:businessId,p_answers:answers.map(answer=>({
   factKey:answer.fieldKey,value:answer.value,unit:answer.unit??null,periodScope:answer.periodScope??null
  }))
 });
 if(error||!Array.isArray(data)||data.length!==answers.length)throw new Error("owner_facts_write_failed");
 return data as {id:string;writeThroughApplied:boolean}[];
}
