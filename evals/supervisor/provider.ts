/** Promptfoo replays recorded model tool calls through the actual SQL research loop.
 * The RPC transport alone is replaced by an isolated SQLite fixture, with no
 * credentials or provider spend. Migrated PostgreSQL/RLS is tested separately. */
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import type {SupabaseClient} from "@supabase/supabase-js";
import {runResearchTurn} from "../../lib/ai/research/turn.server";
import type {AgentProvider} from "../../lib/ai/agent/loop.server";
type Day={date:string;netSalesCents:number;ordersCount:number;wagesCents:number|null;staffTaxCents:number|null};
type Item={id:string;name:string;active:boolean;priceCents:number;recipeCostCents:number;unitsOct19:number};
type Seed={profile:{asOf:string;timezone:string;currency:string};days:Day[];menu:Item[]};
const seed=JSON.parse(readFileSync(new URL("./seed.json",import.meta.url),"utf8")) as Seed;
type ReplayCall={name:string;args:unknown};
type ReplayCase={question:string;tools:ReplayCall[];followUpTools?:ReplayCall[];answer:string};
const replays=JSON.parse(readFileSync(new URL("./replays.json",import.meta.url),"utf8")) as {cases:Record<string,ReplayCase>};
function fixture(){
 const db=new DatabaseSync(":memory:");
 db.exec("create table daily_rollups(business_date text,net_sales_cents integer,orders_count integer,staff_wages_cents integer,staff_tax_cents integer);"+
  "create table menu_items(id text primary key,name text,price_cents integer,is_active integer);"+
  "create table cv_menu(status text,data text);create table cv_item_sales(business_date text,quantity integer,data text);"+
  "create table recipe_lines(menu_item_id text,ingredient_id text,quantity integer);"+
  "create table ingredient_prices(ingredient_id text,cost_per_base_unit_micros integer);"+
  "create table cv_inventory(quantity integer,stock_status text)");
 for(const d of seed.days)db.prepare("insert into daily_rollups values(?,?,?,?,?)").run(d.date,d.netSalesCents,d.ordersCount,d.wagesCents,d.staffTaxCents);
 for(const m of seed.menu){
  db.prepare("insert into menu_items values(?,?,?,?)").run(m.id,m.name,m.priceCents,m.active?1:0);
  db.prepare("insert into cv_menu values('actual',?)").run(JSON.stringify({id:m.id,name:m.name,price_cents:m.priceCents,is_active:m.active}));
  db.prepare("insert into cv_item_sales values(?,?,?)").run(seed.days[0].date,m.unitsOct19,JSON.stringify({name:m.name,menu_item_id:m.id}));
  db.prepare("insert into recipe_lines values(?,?,1)").run(m.id,m.id);
  db.prepare("insert into ingredient_prices values(?,?)").run(m.id,m.recipeCostCents*10000);
 }
 const rpc=async(name:string,params:{p_sql:string})=>{
  if(name!=="supervisor_research_sql"||!/^select\s/i.test(params.p_sql)||params.p_sql.includes(";"))throw Error("unexpected fixture query");
  try{return {data:{ok:true,rows:db.prepare(params.p_sql).all()},error:null};}
  catch(error){return {data:null,error:{message:error instanceof Error?error.message:"fixture query failed"}};}
 };
 return {db,client:{rpc} as unknown as SupabaseClient};
}
function recordedProvider(replay:ReplayCase,results:Map<string,Record<string,unknown>>):AgentProvider{
 const rounds=[replay.tools,...(replay.followUpTools?[replay.followUpTools]:[])];let round=0;
 const allIds=new Map<string,string>();
 return async function*(params){
  round++;
  const input=Array.isArray(params.input)?params.input as Array<{type?:string;call_id?:string;output?:string}>:[];
  for(const [id,name] of allIds){
   const output=input.find(x=>x.type==="function_call_output"&&x.call_id===id)?.output;
   if(!output)throw Error("production tool result missing: "+id);
   const value=JSON.parse(output) as Record<string,unknown>;
   if(value.ok!==true)throw Error("SQL tool failed: "+name);
   results.set(id,{source:name==="calculate"?"calculate":"sql_research",tool:name,...value});
  }
  if(round<=rounds.length){
   if(!Array.isArray(params.tools))throw Error("production Supervisor tools missing");
   for(const [i,call] of rounds[round-1].entries()){
    if(!params.tools.some((tool:unknown)=>!!tool&&typeof tool==="object"&&(tool as {name?:string}).name===call.name))throw Error("production tool missing: "+call.name);
    const id="eval-read-"+round+"-"+i;allIds.set(id,call.name);
    yield {type:"response.output_item.done",item:{type:"function_call",name:call.name,arguments:JSON.stringify(call.args),call_id:id}};
   }
  }else if(round===rounds.length+1){
   yield {type:"response.output_text.delta",delta:replay.answer};
   yield {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[]}};
  }else throw Error("unexpected additional Supervisor model call");
  yield {type:"response.completed",response:{usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0}}}};
 };
}
export default class SupervisorEvalProvider {
 id(){return "supervisor:sql-research:recorded-responses";}
 async callApi(prompt:string,options:{vars?:Record<string,unknown>}={}){
  const replay=replays.cases[String(options.vars?.caseId??"")];
  if(!replay||prompt.trim()!==replay.question.trim())return {error:"Unknown or changed recorded question"};
  const {db,client}=fixture(),results=new Map<string,Record<string,unknown>>();
  try{
   const turn=await runResearchTurn({ownerText:prompt,cafeContext:JSON.stringify(seed.profile),
    scope:{db:client,businessId:"fixture-cafe",ownerUserId:"fixture-owner"},provider:recordedProvider(replay,results)});
   return {output:JSON.stringify({answer:turn.text,status:turn.status.status,endReason:turn.endReason,results:[...results.values()],usedTools:turn.tools??[],unverified:turn.unverified,usage:turn.usage}),cost:0};
  }catch(error){return {error:"Deterministic SQL replay failed: "+(error instanceof Error?error.message:"unknown")};}
  finally{db.close();}
 }
}
