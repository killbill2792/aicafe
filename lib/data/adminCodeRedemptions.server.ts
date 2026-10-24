import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireAdmin} from "@/lib/admin/auth.server";
/** Paginate by code; never treat the latest 500 global redemptions as full history. */
export async function getCodeRedemptionPage(id:string,page:number){
 await requireAdmin();
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) || !Number.isInteger(page) || page<0||page>9999)
  return null;
 const db=createAdminSupabaseClient();
 const {data:code,error:codeError}=await db.from("free_access_codes")
  .select("id,code_hint,max_cafes").eq("id",id).maybeSingle();
 if(codeError)throw codeError;
 if(!code)return null;
 const pageSize=50;
 const {data:rows,error,count}=await db.from("free_access_redemptions")
  .select("business_id,redeemed_by,redeemed_at,access_end",{count:"exact"})
  .eq("code_id",id).order("redeemed_at",{ascending:false})
  .range(page*pageSize,(page+1)*pageSize-1);
 if(error)throw error;
 const ids=[...new Set((rows??[]).map(r=>r.business_id))];
 const {data:cafes,error:cafeError}=ids.length?await db.from("businesses")
  .select("id,name").in("id",ids):{data:[],error:null};
 if(cafeError)throw cafeError;
 const cafeNames=Object.fromEntries((cafes??[]).map(c=>[c.id,c.name]));
 const users=[...new Set((rows??[]).map(r=>r.redeemed_by).filter((x):x is string=>!!x))];
 const emails=await Promise.all(users.map(async userId=>{
  const {data}=await db.auth.admin.getUserById(userId);
  return [userId,data.user?.email??"Unknown"] as const;
 }));
 const ownerEmails=Object.fromEntries(emails);
 return {code,page,pageSize,total:count??0,
  rows:(rows??[]).map(r=>({...r,cafeName:cafeNames[r.business_id]??r.business_id,
   ownerEmail:ownerEmails[r.redeemed_by??""]??"—"}))};
}
