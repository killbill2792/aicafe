import {requireAdmin} from "@/lib/admin/auth.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import CodeConsole from "@/components/admin/CodeConsole";
export const dynamic="force-dynamic";
export default async function CodesPage(){
 await requireAdmin();
 const db=createAdminSupabaseClient();
 const [{data:codes,error:cErr},{data:redemptions,error:rErr},{data:access,error:aErr},{data:cafes,error:bErr}]=await Promise.all([
   db.from("free_access_codes").select("id,code_hint,duration_months,fixed_end_date,max_cafes,note,active,created_at").order("created_at",{ascending:false}).limit(200),
   db.from("free_access_redemptions").select("code_id,business_id,redeemed_by,redeemed_at,access_end").order("redeemed_at",{ascending:false}).limit(500),
   db.from("cafe_access").select("business_id,mode,code_id,access_end").limit(1000),
   db.from("businesses").select("id,name").order("name").limit(1000)
 ]);
 if(cErr||rErr||aErr||bErr)throw cErr??rErr??aErr??bErr;
 const emails=await Promise.all([...new Set((redemptions??[]).map(r=>r.redeemed_by).filter((x):x is string=>!!x))].map(async id=>{
  const {data}=await db.auth.admin.getUserById(id);
  return [id,data.user?.email??"Unknown"] as const;
 }));
 return <CodeConsole codes={codes??[]} redemptions={(redemptions??[]).map(r=>({
   ...r,ownerEmail:Object.fromEntries(emails)[r.redeemed_by??""]??"—"}))}
   access={access??[]} cafes={cafes??[]}/>;
}
