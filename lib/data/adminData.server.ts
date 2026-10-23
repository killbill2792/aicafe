import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/admin/auth.server";
import { getCafeAccess } from "@/lib/access/access.server";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db = () => createAdminSupabaseClient();
function check(error: {message:string}|null) { if(error) throw error; }
type CafeRow={id:string;name:string;created_at:string;is_demo:boolean};
/** Shared per-café projection; details work for any café, not only the first 200. */
async function summarizeCafe(admin:ReturnType<typeof db>,business:CafeRow){
  const id=business.id;
  const [members,threads,pos,sales,staff,menu,access] = await Promise.all([
    admin.from("memberships").select("user_id").eq("business_id",id).eq("role","owner").limit(10),
    admin.from("ai_threads").select("last_message_at").eq("business_id",id).order("last_message_at",{ascending:false}).limit(1),
    admin.from("pos_connections").select("provider,status").eq("business_id",id).limit(1),
    admin.from("orders").select("business_date").eq("business_id",id).order("business_date",{ascending:true}).limit(1),
    admin.from("employees").select("*",{count:"exact",head:true}).eq("business_id",id),
    admin.from("menu_items").select("*",{count:"exact",head:true}).eq("business_id",id),
    getCafeAccess(id),
  ]);
  [members,threads,pos,sales,staff,menu].forEach(item=>check(item.error));
  const latest=await admin.from("orders").select("business_date").eq("business_id",id).order("business_date",{ascending:false}).limit(1);
  check(latest.error);
  const emails=await Promise.all((members.data??[]).map(async m => {
    const {data,error}=await admin.auth.admin.getUserById(m.user_id);
    check(error);
    return data.user?.email??"Unknown";
  }));
  return { ...business, owners:emails, lastActive:threads.data?.[0]?.last_message_at??null,
    pos:pos.data?.[0]??null, firstSale:sales.data?.[0]?.business_date??null,
    lastSale:latest.data?.[0]?.business_date??null,
    staffCount:staff.count??null, menuCount:menu.count??null, access };
}
export async function listCafes(page=0){
  await requireAdmin();
  const safePage=Number.isInteger(page)&&page>=0&&page<=9999?page:0;
  const pageSize=25;
  const admin=db();
  const {data:businesses,error,count}=await admin.from("businesses")
    .select("id,name,created_at,is_demo",{count:"exact"})
    .order("created_at",{ascending:false}).order("id",{ascending:false})
    .range(safePage*pageSize,(safePage+1)*pageSize-1);
  check(error);
  const cafes:Awaited<ReturnType<typeof summarizeCafe>>[]=[];
  // Avoid opening hundreds of database requests in one simultaneous fan-out.
  for(let i=0;i<(businesses??[]).length;i+=8){
    const batch=(businesses??[]).slice(i,i+8);
    cafes.push(...await Promise.all(batch.map(b=>summarizeCafe(admin,b))));
  }
  return {cafes,page:safePage,pageSize,total:count??0};
}
export async function getCafe(id:string){
  await requireAdmin();
  if(!UUID.test(id))return null;
  const admin=db();
  const {data:business,error}=await admin.from("businesses")
    .select("id,name,created_at,is_demo").eq("id",id).maybeSingle();
  check(error);
  return business?summarizeCafe(admin,business):null;
}
export async function listConversations(filters:{cafe?:string; from?:string; to?:string; failed?:boolean; slow?:boolean; down?:boolean}) {
  await requireAdmin();
  let query=db().from("agent_turn_logs").select("id,business_id,thread_id,question,status,started_at,duration_ms,owner_feedback,model,input_tokens,output_tokens,cost_usd")
    .order("started_at",{ascending:false}).limit(100);
  if(filters.cafe && UUID.test(filters.cafe)) query=query.eq("business_id",filters.cafe);
  if(filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) query=query.gte("started_at",filters.from+"T00:00:00Z");
  if(filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) query=query.lte("started_at",filters.to+"T23:59:59Z");
  if(filters.failed) query=query.neq("status","ok");
  if(filters.slow) query=query.gt("duration_ms",20000);
  if(filters.down) query=query.eq("owner_feedback","down");
  const {data,error}=await query;
  check(error); return data??[];
}
export async function getConversation(id:string) {
  await requireAdmin();
  if(!UUID.test(id)) return null;
  const admin=db();
  const {data,error}=await admin.from("agent_turn_logs").select("*").eq("id",id).maybeSingle();
  check(error); if(!data)return null;
  const {data:steps,error:stepError}=await admin.from("agent_turn_steps").select("*").eq("turn_id",id).order("step_order");
  check(stepError);
  const {data:retries,error:retryError}=await admin.from("agent_turn_logs").select("id,status,started_at").eq("retry_of",id);
  check(retryError);
  return {...data,steps:steps??[],retries:retries??[]};
}
