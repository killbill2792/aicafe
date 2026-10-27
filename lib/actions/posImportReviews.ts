"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";

const decision=z.object({
 reviewType:z.enum(["staff_identity","unlinked_timecard","overlapping_timecard","shift_corrected"]),
 sourceKey:z.string().min(1).max(160),
 decision:z.enum(["link_existing","accept_toast","keep_owner"]),
 employeeId:z.string().uuid().optional(),
}).strict();
/** All owner reviews are resolved within the database's own serialized,
 * tenant-checked function. The UI never writes a foreign employee ID. */
export async function resolvePosStaffImportReview(formData:FormData):Promise<void>{
 const input=decision.safeParse({
  reviewType:formData.get("reviewType"),sourceKey:formData.get("sourceKey"),
  decision:formData.get("decision"),
  ...(typeof formData.get("employeeId")==="string"&&formData.get("employeeId")?
   {employeeId:formData.get("employeeId")}:{}),
 });
 if(!input.success)throw new Error("Invalid Toast staff review action");
 const scope=await requireSchedulingOwner();
 if(!scope)throw new Error("Owner authorization required");
 const {data,error}=await scope.supabase.rpc("pos_resolve_staff_import_review",{
  p_business_id:scope.businessId,p_review_type:input.data.reviewType,
  p_source_key:input.data.sourceKey,p_decision:input.data.decision,
  p_employee_id:input.data.employeeId??null,
 });
 if(error)throw error;
 if(data!==true)throw new Error("This review changed; refresh and try again");
 revalidatePath("/staff");
}
