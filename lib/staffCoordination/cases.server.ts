import "server-only";
import {z} from "zod";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import type {SupabaseClient} from "@supabase/supabase-js";

const uuid=z.uuid();
const caseType=z.enum(["leave","recruitment","onboarding"]);
const openInput=z.strictObject({
  nonce:uuid,kind:caseType,employeeId:uuid.nullable(),
  locationId:uuid.nullable(),from:z.iso.date().nullable(),to:z.iso.date().nullable(),
  role:z.string().trim().min(1).max(100).nullable(),
});
const checklistInput=z.strictObject({
 caseId:uuid,revision:z.number().int().positive(),nonce:uuid,
 title:z.string().trim().min(1).max(200),
 prompt:z.string().trim().min(1).max(2000),
});
const decideInput=z.strictObject({
  caseId:uuid,revision:z.number().int().positive(),
  choice:z.enum(["approve","decline","defer"]),
});

export type StaffCoordinationCase={
  id:string;source_kind:string;source_key:string;case_kind:string;
  employee_id:string|null;location_id:string|null;role_needed:string|null;
  from_date:string|null;to_date:string|null;state:string;decision:string|null;
  revision:number;next_check_at:string|null;retention_at:string|null;
  created_at:string;updated_at:string;
};
export class StaffCoordinationError extends Error {
  constructor(public readonly code:"unauthorized"|"invalid"|"conflict"|"storage"){
    super(code);
  }
}
async function owner() {
  const scope=await requireSchedulingOwner();
  if(!scope)throw new StaffCoordinationError("unauthorized");
  return scope;
}
function assertRpcResult(
 data:unknown,error:{code?:string;message?:string}|null,
):{id:string;revision:number;state:string;effectApplied?:boolean}{
 if(error){
  const conflict=error.code==="40900"||/stale_case|nonce_conflict|expired|not_decidable/i.test(error.message??"");
  throw new StaffCoordinationError(conflict?"conflict":
    error.code==="42501"?"unauthorized":"invalid");
 }
 if(!data||typeof data!=="object"||Array.isArray(data)||
  typeof (data as {id?:unknown}).id!=="string"||
  typeof (data as {revision?:unknown}).revision!=="number")
  throw new StaffCoordinationError("storage");
 return data as {id:string;revision:number;state:string;effectApplied?:boolean};
}

/** Owner-only projection. Intentionally no candidate emails, raw employee
 * messages, medical reasons, wages or cross-tenant identifiers in model tools. */
export async function listOwnerStaffCoordination(limit=40):Promise<StaffCoordinationCase[]> {
 const scope=await owner();
 const {data,error}=await scope.supabase.from("staff_coordination_cases")
  .select("id,source_kind,source_key,case_kind,employee_id,location_id,role_needed,from_date,to_date,state,decision,revision,next_check_at,retention_at,created_at,updated_at")
  .eq("business_id",scope.businessId)
  .order("created_at",{ascending:false}).limit(Math.min(Math.max(1,limit),80));
 if(error||!data)throw new StaffCoordinationError("storage");
 return data as StaffCoordinationCase[];
}
/** SQL-claimed, off-turn read for the existing proactive Supervisor worker.
 * Scope is never supplied by model arguments; verify owner still belongs to
 * this café at read time, even if the investigation claim is stale. */
export async function readClaimedStaffCoordination(
 db:SupabaseClient,scope:{businessId:string;ownerUserId:string},
 limit=40,
):Promise<StaffCoordinationCase[]>{
 const membership=await db.from("memberships").select("user_id")
  .eq("business_id",scope.businessId).eq("user_id",scope.ownerUserId)
  .eq("role","owner").maybeSingle();
 if(membership.error||!membership.data)throw new StaffCoordinationError("unauthorized");
 const {data,error}=await db.from("staff_coordination_cases")
  .select("id,source_kind,source_key,case_kind,employee_id,location_id,role_needed,from_date,to_date,state,decision,revision,next_check_at,retention_at,created_at,updated_at")
  .eq("business_id",scope.businessId)
  .order("created_at",{ascending:false}).limit(Math.min(Math.max(1,limit),80));
 if(error||!data)throw new StaffCoordinationError("storage");
 return data as StaffCoordinationCase[];
}
export async function openOwnerStaffCoordination(raw:unknown) {
 const parsed=openInput.safeParse(raw);
 if(!parsed.success)throw new StaffCoordinationError("invalid");
 const p=parsed.data,scope=await owner();
 // An owner-entered record is an owner's report, not authenticated staff consent.
 const {data,error}=await scope.supabase.rpc("staff_coordination_open",{
  p_business_id:scope.businessId,p_nonce:p.nonce,p_kind:p.kind,
  p_employee_id:p.employeeId,p_location_id:p.locationId,
  p_from:p.from,p_to:p.to,p_role:p.role,
 });
 return assertRpcResult(data,error);
}
export async function decideOwnerStaffCoordination(raw:unknown) {
 const parsed=decideInput.safeParse(raw);
 if(!parsed.success)throw new StaffCoordinationError("invalid");
 const p=parsed.data,scope=await owner();
 const {data,error}=await scope.supabase.rpc("staff_coordination_decide",{
  p_business_id:scope.businessId,p_case_id:p.caseId,
  p_revision:p.revision,p_choice:p.choice,
 });
 return assertRpcResult(data,error);
}

/** Owner-approved in-app checklist via the existing 13C service. This is
 * a task assignment, not proof of employment or of staff completion. */
export async function assignOwnerOnboardingChecklist(raw:unknown){
 const parsed=checklistInput.safeParse(raw);
 if(!parsed.success)throw new StaffCoordinationError("invalid");
 const p=parsed.data,scope=await owner();
 const {data,error}=await scope.supabase.rpc("staff_coordination_assign_checklist",{
  p_business_id:scope.businessId,p_case_id:p.caseId,
  p_revision:p.revision,p_nonce:p.nonce,
  p_title:p.title,p_prompt:p.prompt,
 });
 return assertRpcResult(data,error) as {
  id:string;revision:number;state:string;requestId:string;replayed:boolean;
 };
}
