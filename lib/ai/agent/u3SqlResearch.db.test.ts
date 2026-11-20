import {randomBytes,randomUUID} from "node:crypto";
import {Client} from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));
const bridge=vi.hoisted(()=>({
 issue:null as null|((input:Record<string,unknown>)=>Promise<{
  data:string|null;error:{message:string}|null
 }>)
}));
vi.mock("@/lib/supabase/admin",()=>({
 createAdminSupabaseClient:()=>({
  rpc:async(_name:string,input:Record<string,unknown>)=>
   bridge.issue?.(input)??{data:null,error:{message:"local_source_unavailable"}}
 })
}));
import {dataQueryTools} from "./tools/dataQuery";

// The only database accepted by this proof is a migrated disposable localhost
// Supabase fixture. Nothing in this suite can reach a production project.
const active=process.env.U3_SQL_DB_SANDBOX_ONLY==="1";
const connection=process.env.U3_SQL_DB_URL;
const ids={
 a:randomUUID(),b:randomUUID(),oa:randomUUID(),ob:randomUUID(),
 ta:randomUUID(),tb:randomUUID(),orderA:randomUUID(),orderB:randomUUID(),
 lineA:randomUUID(),lineB:randomUUID()
};
let admin:Client|null=null;
let password="";
const priorFlag=process.env.AICAFE_RESEARCH_SQL_ENABLED;
const priorUrl=process.env.AICAFE_RESEARCH_DATABASE_URL;
const scoped={db:{} as never,businessId:ids.a,ownerUserId:ids.oa,
 threadId:ids.ta,mode:"owner" as const};
const input=(sql:string)=>({
 view:null,sql,parameters:[],columns:null,filters:null,group_by:null,
 metrics:null,date_from:null,date_to:null,order_by:null,limit:10
});
describe.skipIf(!active)("U3 migrated registered tool + private connection",()=>{
 beforeAll(async()=>{
  if(!connection)throw Error("U3_SQL_DB_URL missing");
  const u=new URL(connection);
  if(!["127.0.0.1","localhost"].includes(u.hostname)||
    u.port!=="54322"||u.pathname!=="/postgres"||
    !["postgres:","postgresql:"].includes(u.protocol))
   throw Error("U3 DB proof refuses non-disposable database");
  admin=new Client({connectionString:connection,connectionTimeoutMillis:4000});
  await admin.connect();
  const role=await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='aicafe_research'");
  if(role.rows.length!==1||role.rows[0].rolcanlogin!==false)
   throw Error("U3 dedicated research role must begin NOLOGIN");
  password=randomBytes(24).toString("hex");
  // A test-only role password generated for this disposable instance. Never
  // log it, share it, or use a production credential. Cleanup restores NOLOGIN.
  await admin.query("ALTER ROLE aicafe_research LOGIN PASSWORD '"+password+"'");
  const researchUrl=new URL(connection);
  researchUrl.username="aicafe_research";
  researchUrl.password=password;
  process.env.AICAFE_RESEARCH_DATABASE_URL=researchUrl.toString();
  process.env.AICAFE_RESEARCH_SQL_ENABLED="true";
  await admin.query(
   "INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
   "VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',"+
   "'u3-db-owner-a@example.invalid','',now(),now()),"+
   "($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',"+
   "'u3-db-owner-b@example.invalid','',now(),now())",[ids.oa,ids.ob]);
  await admin.query("INSERT INTO public.businesses(id,name,is_demo,timezone,currency) "+
    "VALUES($1,'U3 test-only A',false,'UTC','USD'),"+
    "($2,'U3 test-only B',false,'UTC','USD')",[ids.a,ids.b]);
  await admin.query("INSERT INTO public.memberships(business_id,user_id,role) "+
    "VALUES($1,$2,'owner'),($3,$4,'owner')",[ids.a,ids.oa,ids.b,ids.ob]);
  await admin.query("INSERT INTO public.ai_threads(id,business_id,owner_user_id,client_request_id) "+
    "VALUES($1,$2,$3,gen_random_uuid()),($4,$5,$6,gen_random_uuid())",
    [ids.ta,ids.a,ids.oa,ids.tb,ids.b,ids.ob]);
  await admin.query("INSERT INTO public.orders(id,business_id,pos_order_id,closed_at,business_date,"+
    "gross_sales_cents,net_sales_cents) "+
    "VALUES($1,$2,'u3-synthetic-a',now(),current_date,1100,1100),"+
    "($3,$4,'u3-synthetic-b',now(),current_date,4200,4200)",
    [ids.orderA,ids.a,ids.orderB,ids.b]);
  await admin.query("INSERT INTO public.order_lines(id,order_id,name,quantity,net_sales_cents) "+
    "VALUES($1,$2,'Synthetic item A',1,1100),($3,$4,'Synthetic item B',1,4200)",
    [ids.lineA,ids.orderA,ids.lineB,ids.orderB]);
  bridge.issue=async p=>{
   if(!admin)return {data:null,error:{message:"admin_unavailable"}};
   await admin.query("BEGIN");
   try{
    await admin.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    const call=await admin.query(
     "SELECT public.u3_issue_research_scope($1,$2,$3,$4,$5,$6,$7,$8) AS ticket",
     [p.p_business_id,p.p_owner_user_id,p.p_thread_id,p.p_mode,p.p_source_type,
      p.p_source_id,p.p_run_id,p.p_lease_token]);
    await admin.query("COMMIT");
    return {data:call.rows[0]?.ticket??null,error:null};
   }catch{
    await admin.query("ROLLBACK").catch(()=>{});
    return {data:null,error:{message:"scope_denied"}};
   }
  };
 });
 afterAll(async()=>{
  bridge.issue=null;
  if(admin){
   // The active source is disposable. Do not leave an interactive research
   // credential or synthetic business record after the acceptance test.
   await admin.query("DELETE FROM public.order_lines WHERE id IN ($1,$2)",
    [ids.lineA,ids.lineB]).catch(()=>{});
   await admin.query("DELETE FROM public.orders WHERE id IN ($1,$2)",
    [ids.orderA,ids.orderB]).catch(()=>{});
   await admin.query("DELETE FROM public.ai_threads WHERE id IN ($1,$2)",
    [ids.ta,ids.tb]).catch(()=>{});
   await admin.query("DELETE FROM public.memberships WHERE business_id IN ($1,$2)",
    [ids.a,ids.b]).catch(()=>{});
   await admin.query("DELETE FROM public.businesses WHERE id IN ($1,$2)",
    [ids.a,ids.b]).catch(()=>{});
   await admin.query("DELETE FROM auth.users WHERE id IN ($1,$2)",
    [ids.oa,ids.ob]).catch(()=>{});
   await admin.query("ALTER ROLE aicafe_research NOLOGIN PASSWORD NULL").catch(()=>{});
   await admin.end().catch(()=>{});
  }
  if(priorFlag===undefined)delete process.env.AICAFE_RESEARCH_SQL_ENABLED;
  else process.env.AICAFE_RESEARCH_SQL_ENABLED=priorFlag;
  if(priorUrl===undefined)delete process.env.AICAFE_RESEARCH_DATABASE_URL;
  else process.env.AICAFE_RESEARCH_DATABASE_URL=priorUrl;
 });
 it("discovers admitted relational sources through the real scoped SQL catalog",async()=>{
  const d=await dataQueryTools.describe_data.execute({source:"research",search:"orders"},scoped);
  expect(d.missing).toEqual([]);
  expect(d.source).toBe("u3_semantic_catalog");
  expect(JSON.stringify(d)).toContain("orders");
  expect(JSON.stringify(d)).not.toContain("connector_credentials");
 });
 it("runs a real model-selected join with accurate café-isolated money",async()=>{
  const result=await dataQueryTools.query_data.execute(input(
   "SELECT SUM(i.net_sales_cents) AS cents FROM u3_research.orders o "+
   "JOIN u3_research.order_lines i ON i.order_id=o.id"),scoped);
  expect(result.error).toBeUndefined();
  expect(result.missing).toEqual([]);
  expect(Number((result.rows[0] as Record<string,unknown>).cents)).toBe(1100);
  expect(JSON.stringify(result)).not.toContain("4200");
 });
 it("denies model SQL mutation, forbidden relations and raw data exposure",async()=>{
  for(const sql of [
   "DELETE FROM u3_research.orders",
   "SELECT count(*) FROM public.orders",
   "SELECT * FROM u3_research.toast_records"
  ]){
   const result=await dataQueryTools.query_data.execute(input(sql),scoped);
   expect(result.error).toBe("invalid_query");
   expect(result.rows).toEqual([]);
  }
 });
 it("refuses a foreign owner's signed ticket before any data query",async()=>{
  const other={...scoped,ownerUserId:ids.ob};
  const result=await dataQueryTools.query_data.execute(input(
   "SELECT COUNT(*) AS n FROM u3_research.orders"),other);
  expect(result.error).toBe("research_scope_denied");
  expect(result.rows).toEqual([]);
 });
 it("rechecks actual original-owner authorization after revocation",async()=>{
  if(!admin)throw Error("admin_missing");
  await admin.query("DELETE FROM public.memberships WHERE business_id=$1 AND user_id=$2",
   [ids.a,ids.oa]);
  const result=await dataQueryTools.query_data.execute(input(
   "SELECT COUNT(*) AS n FROM u3_research.orders"),scoped);
  expect(result.error).toBe("research_scope_denied");
  expect(result.rows).toEqual([]);
 });
});
