"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";

const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const availabilityDay=z.strictObject({
 day:z.number().int().min(0).max(6),
 start:time.nullable(),end:time.nullable()
}).refine(d=>(d.start===null)===(d.end===null),"Both times must be specified")
 .refine(d=>d.start===null||d.start!==d.end,"Nonzero window required");
const personFields=z.strictObject({
 name:z.string().trim().min(1).max(80),
 role:z.string().trim().max(60).nullable(),
 wageCents:z.number().int().positive().nullable(),
 availability:z.array(availabilityDay).max(7).refine(days=>
  new Set(days.map(d=>d.day)).size===days.length,"Repeated day"),
 minWeeklyMinutes:z.number().int().min(0).max(10080).nullable(),
 maxWeeklyMinutes:z.number().int().min(0).max(10080).nullable(),
 phone:z.string().regex(/^\+[1-9]\d{1,14}$/).nullable()
}).refine(p=>p.minWeeklyMinutes===null||p.maxWeeklyMinutes===null||
  p.minWeeklyMinutes<=p.maxWeeklyMinutes,"Invalid weekly range");

async function writePerson(id:string|null,input:unknown){
 const p=personFields.safeParse(input);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();
 if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.rpc("staff_write_person",{
  p_business_id:owner.businessId,p_id:id,p_payload:p.data
 });
 if(error||typeof data!=="string")return {ok:false as const,error:error?.code==="P0002"?"not_found":"storage_unavailable"};
 revalidatePath("/staff");return {ok:true as const,id:data};
}
export async function addPerson(raw:unknown){return writePerson(null,raw);}
export async function updatePerson(raw:unknown){
 const p=z.strictObject({id:z.string().uuid(),...personFields.shape}).safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const {id,...fields}=p.data;return writePerson(id,fields);
}
export async function setPersonActive(raw:unknown){
 const p=z.strictObject({id:z.string().uuid(),active:z.boolean()}).safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("employees").update({active:p.data.active})
  .eq("business_id",owner.businessId).eq("id",p.data.id).select("id").maybeSingle();
 if(error||!data)return {ok:false as const,error:"not_found"};
 revalidatePath("/staff");return {ok:true as const,id:data.id as string};
}
