"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
const person=z.strictObject({name:z.string().trim().min(1).max(80),role:z.string().max(60).optional(),wageCents:z.number().int().positive().nullable()});
export async function addPerson(raw:unknown){
 const p=person.safeParse(raw);if(!p.success)return {ok:false as const,error:"Enter a name."};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data,error}=await owner.supabase.from("employees").insert({
  business_id:owner.businessId,display_name:p.data.name,role:p.data.role??null,
  default_hourly_wage_cents:p.data.wageCents,wage_amount_cents:p.data.wageCents,
  wage_period:"hour",active:true
 }).select("id").single();
 if(error||!data)return {ok:false as const,error:"storage_unavailable"};
 revalidatePath("/staff");return {ok:true as const,id:data.id as string};
}
const day=z.strictObject({day:z.number().int().min(0).max(6),start:z.string().regex(/^\d\d:\d\d$/),
 end:z.string().regex(/^\d\d:\d\d$/)});
export async function updatePersonAvailability(raw:unknown){
 const p=z.strictObject({employeeId:z.string().uuid(),days:z.array(day).max(7)}).safeParse(raw);
 if(!p.success)return {ok:false as const,error:"invalid_input"};
 const owner=await requireSchedulingOwner();if(!owner)return {ok:false as const,error:"unauthorized"};
 const {data:employee}=await owner.supabase.from("employees").select("id").eq("business_id",owner.businessId)
 .eq("id",p.data.employeeId).maybeSingle();
 if(!employee)return {ok:false as const,error:"not_found"};
 const {error}=await owner.supabase.from("employees").update({available_days:p.data.days.map(x=>x.day)})
   .eq("business_id",owner.businessId).eq("id",p.data.employeeId);
 if(error)return {ok:false as const,error:"storage_unavailable"};
 // Detailed windows are written to the existing availability table.
 const existing=await owner.supabase.from("staff_availability_rules").select("id")
   .eq("business_id",owner.businessId).eq("employee_id",p.data.employeeId).eq("source","owner_direct");
 if(existing.error)return {ok:false as const,error:"storage_unavailable"};
 if(existing.data?.length){
  const removal=await owner.supabase.from("staff_availability_rules").delete().eq("business_id",owner.businessId)
   .eq("employee_id",p.data.employeeId).eq("source","owner_direct");
  if(removal.error)return {ok:false as const,error:"storage_unavailable"};
 }
 if(p.data.days.length){
  const {error:writeError}=await owner.supabase.from("staff_availability_rules").insert(p.data.days.map(x=>({
    business_id:owner.businessId,employee_id:p.data.employeeId,day_of_week:x.day,
    start_local:x.start,end_local:x.end,source:"owner_direct",effective_from:"2026-01-01",
    overnight:x.end<x.start,confirmation:"unconfirmed"
  })));
  if(writeError)return {ok:false as const,error:"storage_unavailable"};
 }
 revalidatePath("/staff");return {ok:true as const};
}
