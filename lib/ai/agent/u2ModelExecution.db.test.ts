import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";
const sandbox=process.env.U2_MODEL_EXECUTION_DB_SANDBOX_ONLY==="1";
const url=process.env.U2_MODEL_EXECUTION_DB_URL??"";
if(sandbox){
 const u=new URL(url);
 if(!["localhost","127.0.0.1"].includes(u.hostname)||u.port!=="54322"||u.pathname!=="/postgres")
  throw Error("U2 requires a disposable migrated database");
}
async function connect(role:"postgres"|"service_role"|"authenticated",owner?:string){
 const client=new Client({connectionString:url});await client.connect();
 if(role!=="postgres"){
  await client.query("select set_config('request.jwt.claim.role',$1,false)",[role]);
  if(owner)await client.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await client.query("set role "+role);
 }
 return client;
}
function rpc(db:Client,name:string,args:unknown[]){
 return db.query("select to_jsonb(public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+")) result",args).then(r=>r.rows[0]?.result);
}
describe("U2 migrated execution ledger",()=>{
 (sandbox?it:it.skip)("expands exact Luna without expanding café authority or duplicating settlement",async()=>{
 const admin=await connect("postgres"),service=await connect("service_role");let ownerClient:Client|undefined;
 const cafes=[randomUUID(),randomUUID()],owners=[randomUUID(),randomUUID()],threads=[randomUUID(),randomUUID()];
 const alert=randomUUID(),attempt=randomUUID();
 try{
  for(let i=0;i<2;i++){
   await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[owners[i],owners[i]+"@example.invalid"]);
   await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable U2','UTC',false)",[cafes[i]]);
   await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafes[i],owners[i]]);
   await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",[threads[i],cafes[i],owners[i],randomUUID()]);
  }
  ownerClient=await connect("authenticated",owners[1]);
  expect(await rpc(service,"supervisor_model_execution_cap",["gpt-6-luna"])).toBe(8192);
  expect(await rpc(service,"supervisor_model_execution_cap",["gpt-4.1-mini"])).toBe(1200);
  await expect(rpc(ownerClient,"supervisor_model_execution_cap",["gpt-6-luna"])).rejects.toThrow();
  await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new',$3)",[alert,cafes[0],JSON.stringify({quality:"verified",severity:"high"})]);
  const now=new Date(),at=(m:number)=>new Date(now.getTime()+m*60_000).toISOString();
  expect(await rpc(service,"supervisor_enqueue_investigation",[cafes[0],owners[0],threads[0],"alert",alert,"a".repeat(64),"b".repeat(64),315,at(1)])).toBe(true);
  const collect=await rpc(service,"supervisor_claim_investigation",[at(1)]);
  expect(collect.source_id).toBe(alert);
  expect(await rpc(service,"supervisor_finish_investigation",[cafes[0],owners[0],threads[0],"alert",alert,collect.revision_hash,collect.lease_token,"collected",JSON.stringify({source:{kind:"meal_break",status:"new",severity:"high",quality:"verified",relatedAlerts:["meal_break"],relatedTasks:[]},collectedAt:at(1)}),null,at(2)])).toBe(true);
  const claim=await rpc(service,"supervisor_claim_investigation",[at(3)]);
  expect(claim.phase).toBe("investigate");
  const reserve=(id:string,model:string,cap:number,owner=owners[0],lease=claim.lease_token,daily=2)=>rpc(service,"supervisor_reserve_investigation_model_call",[id,cafes[0],owner,threads[0],"alert",alert,lease,model,2000,cap,daily]);
  await expect(reserve(randomUUID(),"gpt-6-luna",8193)).rejects.toThrow();
  await expect(reserve(randomUUID(),"gpt-4.1-mini",8192)).rejects.toThrow();
  await expect(reserve(randomUUID(),"gpt-6-luna",8192,owners[1])).rejects.toThrow();
  await expect(reserve(randomUUID(),"gpt-6-luna",8192,owners[0],randomUUID())).rejects.toThrow();
  await reserve(attempt,"gpt-6-luna",8192);
  const receipt={kind:"responses",model:"gpt-6-luna",requestedModel:"gpt-6-luna",outcome:"completed",final:false,nativeSearch:true,outputCap:8192,durationMs:50,inputTokens:100,cachedTokens:20,outputTokens:2000,reasoningTokens:1500,nonReasoningTokens:500,estimatedCostMicros:100,discoveryCalls:1};
  const settle=(id:string,output:number,metrics:object)=>rpc(service,"supervisor_complete_investigation_model_call",[id,cafes[0],owners[0],threads[0],"gpt-6-luna",100,output,100,JSON.stringify(metrics)]);
  await expect(settle(attempt,8193,receipt)).rejects.toThrow();
  await settle(attempt,2000,receipt);
  await expect(settle(attempt,2000,receipt)).rejects.toThrow();
  const incomplete=randomUUID();await reserve(incomplete,"gpt-6-luna",8192);
  await settle(incomplete,0,{...receipt,outcome:"failed",outputTokens:null,reasoningTokens:null,nonReasoningTokens:null});
  await expect(reserve(randomUUID(),"gpt-6-luna",8192)).rejects.toThrow();
  const rows=await admin.query("select attempt_id,status,output_tokens,execution_metrics from public.supervisor_system_usage_events where business_id=$1 order by status",[cafes[0]]);
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows.find(x=>x.attempt_id===attempt)).toMatchObject({status:"completed",output_tokens:"2000",execution_metrics:receipt});
  expect(rows.rows.find(x=>x.attempt_id===incomplete)).toMatchObject({status:"attempted",output_tokens:null,execution_metrics:{outcome:"failed"}});
  expect((await ownerClient.query("select attempt_id from public.supervisor_system_usage_events where business_id=$1",[cafes[0]])).rows).toEqual([]);
 }finally{await ownerClient?.end();await service.end();await admin.query("delete from public.businesses where id=any($1::uuid[])",[cafes]);await admin.query("delete from auth.users where id=any($1::uuid[])",[owners]);await admin.end()}
 },30000);
});
