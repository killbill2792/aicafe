import "server-only";
import {personFields,updatePersonFields,setPersonActiveInput} from "@/lib/calc/scheduling/scheduleValidators";
import {normalizeStaffPhone} from "@/lib/calc/scheduling/staffPhone";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";

async function writePerson(id:string|null,input:unknown){
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:false as const,error:"unauthorized"};
 const raw=input&&typeof input==="object"?input as Record<string,unknown>:{};
 const {data:location,error:locationError}=await owner.supabase.from("locations")
   .select("country_code").eq("business_id",owner.businessId).order("name").limit(1).maybeSingle();
 if(locationError)return {ok:false as const,error:"storage_unavailable"};
 const phone=raw.phone===undefined||raw.phone===null||typeof raw.phone==="string"
   ?normalizeStaffPhone(raw.phone as string|null|undefined,location?.country_code??null):raw.phone;
 if(phone===undefined)return {ok:false as const,error:"invalid_phone"};
 const values={...raw,phone};
 const p=id?updatePersonFields.safeParse({...values,id}):personFields.safeParse(values);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const {data,error}=await owner.supabase.rpc("staff_write_person",{
  p_business_id:owner.businessId,p_id:id,p_payload:id?Object.fromEntries(Object.entries(p.data).filter(([key])=>key!=="id")):p.data
 });
 if(error||typeof data!=="string")return {ok:false as const,error:error?.code==="P0002"?"not_found":"storage_unavailable"};
 return {ok:true as const,id:data};
}
export async function addPerson(raw:unknown){return writePerson(null,raw);}
export async function updatePerson(raw:unknown){
 const id=raw&&typeof raw==="object"?(raw as {id?:unknown}).id:undefined;
 if(typeof id!=="string")return {ok:false as const,error:"invalid_input"};
 return writePerson(id,raw);
}
export async function setPersonActive(raw:unknown){
 const p=setPersonActiveInput.safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("employees").update({active:p.data.active})
  .eq("business_id",owner.businessId).eq("id",p.data.id).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:error?"storage_unavailable":"not_found"};
 // The employee table's AFTER UPDATE trigger atomically deactivates any
 // repeating staff_schedules. A trigger failure rolls back this update.
 return {ok:true as const,id:data.id as string};
}
