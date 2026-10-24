import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
type StaffSourceScope={businessId:string;ownerUserId:string};
export type StaffProposalPerson={id:string;display_name:string;role:string|null;active:boolean;
 wage_period:string;wage_amount_cents:number|null;phone_e164:string|null;whatsapp_opt_in:boolean};
export type StaffProposalShift={id:string;employee_id:string;local_date:string;start_local:string;end_local:string;break_minutes:number;status:string;deleted_at:string|null};

async function verifyOwner(scope:StaffSourceScope){
 const owner=await requireSchedulingOwner();
 if(!owner||owner.businessId!==scope.businessId)throw new Error("Only the current café owner can propose staff changes");
 const user=await owner.supabase.auth.getUser();
 if(user.error||user.data.user?.id!==scope.ownerUserId)throw new Error("Owner session changed");
 return owner;
}
export async function readStaffProposalToken(scope:StaffSourceScope,dependencyScope?:import("@/lib/ai/supervisor/loop/staffProposals.server").StaffDependencyScope){
 await verifyOwner(scope);
 const {data,error}=await createAdminSupabaseClient().rpc(dependencyScope?"supervisor_staff_scoped_token":"supervisor_staff_source_token",dependencyScope?
  {p_business_id:scope.businessId,p_scope:dependencyScope}:{p_business_id:scope.businessId});
 if(error||typeof data!=="string"||!/^[a-f0-9]{32}$/.test(data))throw new Error("Staff revision unavailable; apply migration 091");
 return data;
}

export async function readStaffProposalSources(scope:StaffSourceScope,from:string|null,to:string|null){
 await verifyOwner(scope);
 const db=createAdminSupabaseClient();
 const [peopleResult,shiftsResult,rulesResult,availabilityResult,exceptionsResult,locationResult]=await Promise.all([
  db.from("employees").select("id,display_name,role,active,wage_period,wage_amount_cents,phone_e164,whatsapp_opt_in").eq("business_id",scope.businessId).limit(501),
  from&&to?db.from("scheduled_shifts").select("id,employee_id,local_date,start_local,end_local,break_minutes,status,deleted_at")
    .eq("business_id",scope.businessId).is("deleted_at",null).gte("local_date",from).lte("local_date",to).limit(501)
    :Promise.resolve({data:[],error:null}),
  db.from("team_rules").select("*").eq("business_id",scope.businessId).maybeSingle(),
  db.from("staff_availability_rules").select("employee_id,day_of_week,start_local,end_local,effective_from,effective_to,source").eq("business_id",scope.businessId).limit(501),
  db.from("staff_availability_exceptions").select("employee_id,local_date,exception_type,start_local,end_local,max_minutes").eq("business_id",scope.businessId).limit(501),
  db.from("locations").select("id").eq("business_id",scope.businessId).limit(501),
 ]);
 if([peopleResult,shiftsResult,rulesResult,availabilityResult,exceptionsResult,locationResult].some(r=>r.error))
  throw new Error("Staff preview unavailable");
 if([peopleResult,shiftsResult,availabilityResult,exceptionsResult,locationResult].some(r=>(r.data??[]).length>500))
  throw new Error("Too many staff records to preview safely");
 const people=(peopleResult.data??[]) as StaffProposalPerson[],shifts=(shiftsResult.data??[]) as StaffProposalShift[];

 const cafeZone=await db.from("businesses").select("timezone,currency")
   .eq("id",scope.businessId).single();
 if(cafeZone.error||!cafeZone.data?.timezone||!cafeZone.data.currency||!/^[A-Z]{3}$/.test(cafeZone.data.currency))throw new Error("Café locale/currency unavailable");

 return {people,shifts,
  rules:(rulesResult.data??null) as Record<string,unknown>|null,
  availability:(availabilityResult.data??[]) as Array<{employee_id:string;day_of_week:number;start_local:string;end_local:string}>,
  exceptions:(exceptionsResult.data??[]) as Array<{employee_id:string;local_date:string;exception_type:string;start_local:string|null;end_local:string|null;max_minutes:number|null}>,
  timezone:cafeZone.data!.timezone as string,currency:cafeZone.data!.currency as string};
}
