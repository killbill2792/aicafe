import "server-only";
import {personFields,updatePersonFields,setPersonActiveInput} from "@/lib/calc/scheduling/scheduleValidators";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";

async function writePerson(id:string|null,input:unknown){
 const p=id?updatePersonFields.safeParse({...((input&&typeof input==="object")?input as Record<string,unknown>:{}),id}):
   personFields.safeParse(input);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.rpc("staff_write_person",{
  p_business_id:owner.businessId,p_id:id,p_payload:id?Object.fromEntries(Object.entries(p.data).filter(([key])=>key!=="id")):p.data
 });
 if(error||typeof data!=="string")return {ok:false as const,error:error?.code==="P0002"?"not_found":"storage_unavailable"};
 return {ok:true as const,id:data};
}
export async function addPerson(raw:unknown){return writePerson(null,raw);}
export async function updatePerson(raw:unknown){
 const p=updatePersonFields.safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const {id,...fields}=p.data;return writePerson(id,fields);
}
export async function setPersonActive(raw:unknown){
 const p=setPersonActiveInput.safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("employees").update({active:p.data.active})
  .eq("business_id",owner.businessId).eq("id",p.data.id).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 return {ok:true as const,id:data.id as string};
}
