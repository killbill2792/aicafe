import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosEmployee} from "./types";
type EmployeeRow={id:string;display_name:string;pos_team_member_id:string|null;role:string|null;
 active:boolean;default_hourly_wage_cents:number|null;pos_display_name:string|null;
 pos_last_role:string|null;pos_last_wage_cents:number|null;pos_last_active:boolean|null};
const normalize=(s:string)=>s.trim().normalize("NFKD").toLowerCase().replace(/\s+/g," ");
/** One employee importer for Square, Toast and future registers. Never erase owner edits. */
export async function syncCanonicalEmployees(db:SupabaseClient,businessId:string,adapter:PosAdapter,provided?:PosEmployee[]){
 const incoming=provided??await adapter.fetchEmployees();
 const {data,error}=await db.from("employees").select(
  "id,display_name,pos_team_member_id,role,active,default_hourly_wage_cents,pos_display_name,pos_last_role,pos_last_wage_cents,pos_last_active"
 ).eq("business_id",businessId);
 if(error)throw error;
 const existing=(data??[]) as EmployeeRow[];
 let created=0,linked=0,updated=0,review=0;
 for(const person of incoming){
  let row=existing.find(e=>e.pos_team_member_id===person.posTeamMemberId);
  if(!row){
   const names=existing.filter(e=>normalize(e.display_name)===normalize(person.displayName));
   // Competing owner/manual staff identities require one review, never a guess.
   if(names.length>1||names.length===1&&names[0].pos_team_member_id!==null){
    const {error:re}=await db.from("pos_import_reviews").upsert({
     business_id:businessId,provider:adapter.provider,review_type:"staff_identity",
     source_key:person.posTeamMemberId,detail:{
       displayName:person.displayName,candidates:names.map(e=>e.id)}
    },{onConflict:"business_id,provider,review_type,source_key"});
    if(re)throw re;review++;continue;
   }
   row=names.length===1?names[0]:undefined;
  }
  const posActive=person.active!==false;
  const wage=person.hourlyWageCents??null;
  if(row){
   const patch:Record<string,unknown>={};
   if(row.pos_team_member_id!==person.posTeamMemberId)
    patch.pos_team_member_id=person.posTeamMemberId;
   if(row.pos_display_name===null||row.display_name===row.pos_display_name)
    if(row.display_name!==person.displayName)patch.display_name=person.displayName;
   if(row.pos_display_name!==person.displayName)patch.pos_display_name=person.displayName;
   if(person.role!==null&&(row.role===null||row.role===row.pos_last_role)&&row.role!==person.role)
    patch.role=person.role;
   if(person.role!==null&&row.pos_last_role!==person.role)patch.pos_last_role=person.role;
   if(wage!==null&&(row.default_hourly_wage_cents===null||
     row.default_hourly_wage_cents===row.pos_last_wage_cents)
     &&row.default_hourly_wage_cents!==wage)patch.default_hourly_wage_cents=wage;
   if(wage!==null&&row.pos_last_wage_cents!==wage)patch.pos_last_wage_cents=wage;
   const ownerDisabled=row.pos_last_active===true&&row.active===false;
   if(!ownerDisabled&&row.active!==posActive)patch.active=posActive;
   if(row.pos_last_active!==posActive)patch.pos_last_active=posActive;
   if(Object.keys(patch).length){
    const {error:writeError}=await db.from("employees").update({
      ...patch,pos_last_synced_at:new Date().toISOString()
    }).eq("business_id",businessId).eq("id",row.id);
    if(writeError)throw writeError;updated++;
    Object.assign(row,patch);
   }
   linked++;
  }else{
   const {data:inserted,error:insertError}=await db.from("employees").upsert({
    business_id:businessId,pos_team_member_id:person.posTeamMemberId,
    display_name:person.displayName,pos_display_name:person.displayName,
    role:person.role,pos_last_role:person.role,active:posActive,pos_last_active:posActive,
    default_hourly_wage_cents:wage,pos_last_wage_cents:wage,
    pos_last_synced_at:new Date().toISOString()
   },{onConflict:"business_id,pos_team_member_id"}).select("id").single();
   if(insertError)throw insertError;
   if(!inserted)throw new Error("POS staff upsert failed");
   created++;
   row={id:inserted.id,display_name:person.displayName,pos_team_member_id:person.posTeamMemberId,
    role:person.role,active:posActive,default_hourly_wage_cents:wage,
    pos_display_name:person.displayName,pos_last_role:person.role,
    pos_last_wage_cents:wage,pos_last_active:posActive};
   existing.push(row);
  }
  if(adapter.provider==="toast"){
   const parts=person.posTeamMemberId.split(":");
   const restaurantGuid=parts[1],employeeGuid=parts[2];
   if(!restaurantGuid||!employeeGuid)throw new Error("Invalid Toast employee identifier");
   const {error:linkError}=await db.from("toast_employee_directory").update({
     linked_employee_id:row.id,linked_at:new Date().toISOString()
   }).eq("business_id",businessId).eq("restaurant_guid",restaurantGuid)
    .eq("employee_guid",employeeGuid)
    .or("linked_employee_id.is.null,linked_employee_id.eq."+row.id);
   if(linkError)throw linkError;
  }
 }
 // An employee absent from a complete Toast/Square roster is inactive unless
 // the owner had already explicitly disabled them.
 const ids=new Set(incoming.map(e=>e.posTeamMemberId));
 for(const row of existing){
  if(!row.pos_team_member_id||ids.has(row.pos_team_member_id))continue;
  const prefix=adapter.provider==="toast"?"toast:":adapter.provider==="square"?"":adapter.provider+":";
  if(adapter.provider==="toast"&&!row.pos_team_member_id.startsWith(prefix))continue;
  if(adapter.provider==="square"&&row.pos_team_member_id.startsWith("toast:"))continue;
  if(row.active&&row.pos_last_active!==null){
   const {error:offError}=await db.from("employees").update({
    active:false,pos_last_active:false,pos_last_synced_at:new Date().toISOString()
   }).eq("business_id",businessId).eq("id",row.id);
   if(offError)throw offError;updated++;
  }
 }
 return {created,linked,updated,review};
}
