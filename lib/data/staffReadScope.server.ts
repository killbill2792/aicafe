import "server-only";
import {isSupabaseConfigured} from "@/lib/supabase/client";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {DEMO_BUSINESS_ID} from "@/lib/constants";
import {localDateInZone} from "@/lib/scheduling/localDate";

/** Read scope accepts members and the demo; all mutations use requireSchedulingOwner. */
export async function staffReadScope(){
 if(!isSupabaseConfigured())return {
  ok:true as const, supabase:null,businessId:DEMO_BUSINESS_ID,
  readOnly:true,timezone:"America/Los_Angeles",currency:"USD",today:localDateInZone(new Date(),"America/Los_Angeles")
 };
 const supabase=await createServerSupabaseClient();
 const {data:{user}}=await supabase.auth.getUser();
 if(!user)return {ok:false as const,error:"unauthorized"};
 const businessId=await getActiveBusinessId(user.id);
 const [membership,business]=await Promise.all([
  supabase.from("memberships").select("role").eq("business_id",businessId).eq("user_id",user.id).maybeSingle(),
  supabase.from("businesses").select("timezone,currency,is_demo").eq("id",businessId).maybeSingle()
 ]);
 if(membership.error||business.error||!membership.data||!business.data)return {ok:false as const,error:"unauthorized"};
 const timezone=business.data.timezone as string||"America/Los_Angeles";
 return {ok:true as const,supabase,businessId,
  readOnly:membership.data.role!=="owner"||business.data.is_demo===true||businessId===DEMO_BUSINESS_ID,
  timezone,currency:(business.data.currency as string)||"USD",
  today:localDateInZone(new Date(),timezone)};
}
export function mondayOfLocalDate(localDate:string){
 const d=new Date(localDate+"T12:00:00Z");
 return new Date(Date.parse(localDate+"T12:00:00Z")-((d.getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);
}
