import {randomUUID} from "node:crypto";
import {Client} from "pg";
import type {SupabaseClient} from "@supabase/supabase-js";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {calculate,executeResearchTool,type ResearchScope} from "./tools.server";
import {runResearchTurn} from "./turn.server";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";

// Migrated disposable database only (CI local Supabase, or a local migrated
// PostgreSQL). Never point this at a real café database.
const url=process.env.SUPERVISOR_RESEARCH_DB_URL??"";
const enabled=url!=="";
if(enabled&&!["localhost","127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("research DB test only runs against a local disposable database");

let admin:Client;
const cafeA=randomUUID(),cafeB=randomUUID(),otherCafe=randomUUID();
const owner=randomUUID(),otherOwner=randomUUID();
const sales:Record<string,number[]>={[cafeA]:[1250,980,2010,455],[cafeB]:[700,300],[otherCafe]:[99999]};

/** Calls the function the way PostgREST does for the server's service-role
 * client: one transaction, role service_role, service claims. */
function serviceClient():SupabaseClient{
  return {rpc:async(name:string,params:Record<string,unknown>)=>{
    const db=new Client({connectionString:url});
    await db.connect();
    try{
      await db.query("begin");
      await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
      await db.query("set local role service_role");
      const r=await db.query("select public."+name+"($1,$2,$3) as data",[params.p_business_id,params.p_owner_user_id,params.p_sql]);
      await db.query("commit");
      return {data:r.rows[0].data,error:null};
    }catch(error){
      await db.query("rollback").catch(()=>undefined);
      return {data:null,error:{message:error instanceof Error?error.message:String(error)}};
    }finally{await db.end();}
  }} as unknown as SupabaseClient;
}
const scope=(businessId:string,ownerUserId=owner):ResearchScope=>({db:serviceClient(),businessId,ownerUserId});
const sql=(s:ResearchScope,text:string)=>executeResearchTool(s,"run_sql",JSON.stringify({sql:text}));

beforeAll(async()=>{
  if(!enabled)return;
  admin=new Client({connectionString:url});
  await admin.connect();
  for(const uid of [owner,otherOwner])
    await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
      "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[uid,uid+"@example.invalid"]);
  for(const [id,name,currency] of [[cafeA,"Research A","EUR"],[cafeB,"Research B","USD"],[otherCafe,"Research Other","GBP"]])
    await admin.query("insert into public.businesses(id,name,timezone,currency) values ($1,$2,'Europe/Madrid',$3)",[id,name,currency]);
  // The same owner owns A and B; a different owner owns the third café.
  await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$3,'owner'),($2,$3,'owner'),($4,$5,'owner')",
    [cafeA,cafeB,owner,otherCafe,otherOwner]);
  for(const [cafe,amounts] of Object.entries(sales))
    for(const [i,cents] of amounts.entries())
      await admin.query("insert into public.orders(business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents) "+
        "values ($1,$2,now(),current_date - $3::int,$4,$4)",[cafe,"r-"+cafe+"-"+i,i,cents]);
});
afterAll(async()=>{
  if(!enabled)return;
  await admin.query("delete from public.orders where business_id = any($1)",[[cafeA,cafeB,otherCafe]]);
  await admin.query("delete from public.memberships where business_id = any($1)",[[cafeA,cafeB,otherCafe]]);
  await admin.query("delete from public.businesses where id = any($1)",[[cafeA,cafeB,otherCafe]]);
  await admin.query("delete from auth.users where id = any($1)",[[owner,otherOwner]]);
  await admin.end();
});

describe("calculator connection",()=>{
  it("does exact arithmetic on retrieved values",()=>{
    const r=calculate({inputs:[{name:"a",value:"4695",unit:"cents"},{name:"n",value:"4",unit:"count"},{name:"vat",value:"10",unit:"percent"}],
      steps:[{id:"avg",op:"divide",args:["a","n"]},{id:"tax",op:"percent_of",args:["vat","a"]}]});
    expect(r).toMatchObject({ok:true,steps:[{id:"avg",value:"1173.75",unit:"cents"},{id:"tax",value:"469.5",unit:"cents"}]});
    expect(calculate({inputs:[{name:"a",value:"1e3",unit:"count"}],steps:[{id:"x",op:"sum",args:["a"]}]})).toMatchObject({ok:false});
  });
});

describe.skipIf(!enabled)("direct SQL research on the migrated database",()=>{
  it("discovers readable tables, columns and links",async()=>{
    const all=await executeResearchTool(scope(cafeA),"describe_database",JSON.stringify({tables:null}));
    expect(all.ok).toBe(true);
    const names=(all.rows as {name:string}[]).map(r=>r.name);
    expect(names).toEqual(expect.arrayContaining(["orders","order_lines","menu_items","businesses"]));
    // Service-only tables are not readable by the owner role.
    expect(names).not.toContain("toast_client_budgets");
    const detail=await executeResearchTool(scope(cafeA),"describe_database",JSON.stringify({tables:["orders"]}));
    const columns=(detail.columns as {rows:{column:string}[]}).rows.map(r=>r.column);
    expect(columns).toEqual(expect.arrayContaining(["business_id","net_sales_cents","business_date"]));
    expect(JSON.stringify(detail.foreign_keys)).toContain("businesses");
  });

  it("answers with this café's rows only, matching an independent admin query",async()=>{
    for(const cafe of [cafeA,cafeB]){
      const r=await sql(scope(cafe),"select count(*)::int as orders, sum(net_sales_cents)::bigint as net from orders");
      const truth=(await admin.query("select count(*)::int as orders, sum(net_sales_cents)::bigint as net from orders where business_id=$1",[cafe])).rows[0];
      expect(r).toMatchObject({ok:true,rows:[{orders:truth.orders,net:Number(truth.net)}]});
    }
    const seen=await sql(scope(cafeA),"select distinct business_id from orders union select id from businesses union select business_id from memberships");
    expect((seen.rows as {business_id:string}[]).map(r=>r.business_id)).toEqual([cafeA]);
  });

  it("refuses a café the caller does not own",async()=>{
    const r=await sql(scope(otherCafe),"select count(*) from orders");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("supervisor_research_not_owner");
  });

  it("is read-only and returns useful SQL errors",async()=>{
    const before=(await admin.query("select count(*)::int n from orders where business_id=$1",[cafeA])).rows[0].n;
    for(const text of [
      "delete from orders",
      "with d as (delete from orders returning 1) select count(*) from d",
      "select 1; delete from orders",
      "select refresh_processing_fee_daily_fact('"+cafeA+"',current_date)",
    ]) expect((await sql(scope(cafeA),text)).ok).toBe(false);
    expect((await admin.query("select count(*)::int n from orders where business_id=$1",[cafeA])).rows[0].n).toBe(before);
    const bad=await sql(scope(cafeA),"select net_salez from orders");
    expect(bad).toMatchObject({ok:false,sqlstate:"42703"});
    expect(String(bad.error)).toContain("net_salez");
  });

  it("cannot switch identity to another owner",async()=>{
    for(const text of [
      "select set_config('request.jwt.claim.sub','"+otherOwner+"',true), (select count(*) from orders)",
      "select * from query_to_xml('select * from orders',true,true,'')",
      "select U&\"\\0073et_config\"('request.jwt.claim.sub','"+otherOwner+"',true)",
    ]){
      const r=await sql(scope(cafeA),text);
      expect(r.ok).toBe(false);
    }
  });

  it("runs the chat turn: discovery, SQL and calculation feed the owner's answer",async()=>{
    const seenOutputs:string[]=[];
    let step=0;
    const call=(name:string,args:unknown)=>({type:"response.output_item.done",item:{type:"function_call",name,call_id:"c"+step+name,arguments:JSON.stringify(args)}});
    const done={type:"response.completed",response:{model:"test-model",usage:{input_tokens:10,output_tokens:5}}};
    // Scripted transport: only checks the loop wiring and the data the
    // model receives. It is NOT evidence of a real model's reasoning.
    const provider:AgentProvider=async function*(params){
      const input=params.input as {type?:string;output?:string}[];
      for(const item of input)if(item.type==="function_call_output"&&item.output)seenOutputs.push(item.output);
      expect(params.tools).toHaveLength(3);
      step++;
      if(step===1){yield call("describe_database",{tables:null});yield done;return;}
      if(step===2){yield call("run_sql",{sql:"select sum(net_sales_cents)::bigint as net, count(*)::int as n from orders"});yield done;return;}
      if(step===3){
        const last=JSON.parse(seenOutputs[seenOutputs.length-1]) as {rows:{net:number;n:number}[]};
        yield call("calculate",{inputs:[{name:"net",value:String(last.rows[0].net),unit:"cents"},{name:"n",value:String(last.rows[0].n),unit:"count"}],
          steps:[{id:"avg",op:"divide",args:["net","n"]}]});yield done;return;
      }
      const calc=JSON.parse(seenOutputs[seenOutputs.length-1]) as {result:{value:string}};
      yield {type:"response.output_text.delta",delta:"Average order: "+calc.result.value+" cents."};
      yield {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[]}};
      yield done;
    };
    const turn=await runResearchTurn({ownerText:"What is my average order value?",scope:scope(cafeA),
      cafeContext:"Café: Research A",provider});
    expect(turn.endReason).toBe("complete");
    expect(turn.tools).toEqual(["describe_database","run_sql","calculate"]);
    const avg=sales[cafeA].reduce((a,b)=>a+b,0)/sales[cafeA].length;
    expect(turn.text).toBe("Average order: "+avg+" cents.");
    expect(turn.usage).toMatchObject({modelCalls:4,toolCalls:3});
  });
});
