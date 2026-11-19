"use server";

import {revalidatePath} from "next/cache";
import {z} from "zod";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

const reportSchema=z.strictObject({
  nonce:z.uuid(),
  equipmentLabel:z.string().trim().min(1).max(120),
  symptom:z.string().trim().min(1).max(1200),
  severity:z.enum(["critical","high","normal","unknown"]),
  observedAt:z.iso.datetime({offset:true}),
});
const progressSchema=z.strictObject({
  taskId:z.string().min(1).max(160).startsWith("maintenance:"),
  nonce:z.uuid(),
  kind:z.enum(["repair_claim","operational_verification","blocked","reopened","follow_up"]),
  note:z.string().max(1200),
  workingConfirmed:z.boolean(),
});
export type MaintenanceActionResult=
  |{ok:true;taskId:string;stage?:string}
  |{ok:false;error:"invalid_request"|"owner_access_required"|"source_unavailable"|"conflict"};

/** Owner scope is derived from the authenticated session, never from model input. */
async function ownerSession(){
  const supabase=await createServerSupabaseClient();
  const {data:{user},error}=await supabase.auth.getUser();
  if(error||!user)return null;
  const businessId=await getActiveBusinessId(user.id).catch(()=>null);
  return businessId?{supabase,businessId}:null;
}
export async function reportMaintenanceCase(raw:unknown):Promise<MaintenanceActionResult>{
  const parsed=reportSchema.safeParse(raw);
  if(!parsed.success)return {ok:false,error:"invalid_request"};
  const session=await ownerSession();
  if(!session)return {ok:false,error:"owner_access_required"};
  const {data,error}=await session.supabase.rpc("maintenance_report_case",{
    p_business_id:session.businessId,
    p_case_nonce:parsed.data.nonce,
    p_equipment_label:parsed.data.equipmentLabel,
    p_symptom:parsed.data.symptom,
    p_severity:parsed.data.severity,
    p_observed_at:parsed.data.observedAt,
  });
  if(error||typeof data!=="string")return {ok:false,error:error?.code==="23505"?"conflict":"source_unavailable"};
  revalidatePath("/operations");
  revalidatePath("/");
  return {ok:true,taskId:data,stage:"reported"};
}
/** Claim and independent working-equipment check are separate transactions. */
export async function recordMaintenanceProgress(raw:unknown):Promise<MaintenanceActionResult>{
  const parsed=progressSchema.safeParse(raw);
  if(!parsed.success)return {ok:false,error:"invalid_request"};
  const session=await ownerSession();
  if(!session)return {ok:false,error:"owner_access_required"};
  const {data,error}=await session.supabase.rpc("maintenance_record_progress",{
    p_business_id:session.businessId,
    p_task_id:parsed.data.taskId,
    p_nonce:parsed.data.nonce,
    p_kind:parsed.data.kind,
    p_note:parsed.data.note,
    p_working_confirmed:parsed.data.workingConfirmed,
  });
  if(error||typeof data!=="string")return {ok:false,error:"source_unavailable"};
  revalidatePath("/operations");
  revalidatePath("/");
  return {ok:true,taskId:parsed.data.taskId,stage:data};
}

/** Explicit owner approval for exact employee and work in the existing inbox. */
export async function assignMaintenanceWork(raw:unknown):Promise<MaintenanceActionResult>{
  const parsed=z.strictObject({taskId:z.string().startsWith("maintenance:").max(160),
    employeeId:z.uuid(),nonce:z.uuid(),prompt:z.string().trim().min(1).max(1200)}).safeParse(raw);
  if(!parsed.success)return {ok:false,error:"invalid_request"};
  const session=await ownerSession();
  if(!session)return {ok:false,error:"owner_access_required"};
  const {data,error}=await session.supabase.rpc("maintenance_assign_staff",{
    p_business_id:session.businessId,p_task_id:parsed.data.taskId,p_employee_id:parsed.data.employeeId,
    p_nonce:parsed.data.nonce,p_prompt:parsed.data.prompt,
  });
  if(error||typeof data?.id!=="string")return {ok:false,error:"source_unavailable"};
  revalidatePath("/operations");revalidatePath("/");
  return {ok:true,taskId:parsed.data.taskId};
}
