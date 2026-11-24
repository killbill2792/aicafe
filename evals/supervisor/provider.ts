/**
 * Promptfoo exercises the production Supervisor agent loop with read-only,
 * anonymized café readers. Never copy the system prompt into eval code.
 */
import { readFileSync } from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {admitU3Sql,type U3RelationUnits} from "../../lib/ai/agent/tools/u3SqlAdmission";
import {u3SqlSchema,type runU3Sql} from "../../lib/ai/agent/tools/u3SqlResearch.server";
import { runAgentTurn, type AgentProvider } from "../../lib/ai/agent/loop.server";
import type { AgentToolContext, AgentToolName } from "../../lib/ai/agent/tools";

type Day = {date:string;netSalesCents:number;ordersCount:number;wagesCents:number|null;
  staffTaxCents:number|null;loadedStaffCostCents:number|null;wageStatus:"actual"|"missing"};
type Item = {id:string;name:string;category:string;active:boolean;priceCents:number;
  recipeCostCents:number;unitsOct19:number};
type Seed = { profile:{asOf:string;timezone:string;currency:string};
  days:Day[];menu:Item[] };
const seed = JSON.parse(readFileSync(new URL("./seed.json",import.meta.url),"utf8")) as Seed;
type ReplayCall = {name:AgentToolName;args:unknown};
type ReplayCase = {question:string;tools:ReplayCall[];followUpTools?:ReplayCall[];answer:string};
const replays = JSON.parse(readFileSync(new URL("./replays.json",import.meta.url),"utf8")) as
  {cases:Record<string,ReplayCase>};
// SQL is executed against the same synthetic rows as before, independently of
// the golden oracle. PostgreSQL grammar/admission and numeric lineage use the
// production parser; SQLite is only the isolated deterministic data transport.
// No provider or production database is contacted.
const relations:U3RelationUnits={
 daily_rollups:{business_date:null,net_sales_cents:"cents",staff_wages_cents:"cents",staff_tax_cents:"cents",labor_wage_status:null},
 menu_items:{id:null,name:null,is_active:null,price_cents:"cents"},
 recipe_lines:{menu_item_id:null,ingredient_id:null,quantity:"count"},
 ingredient_prices:{ingredient_id:null,cost_per_base_unit_micros:"microcents"},
 orders:{id:null,business_date:null},
 order_lines:{order_id:null,menu_item_id:null,quantity:"count",voided:null},
 inventory_observations:{quantity:"count",evidence_state:null},
};
const readSql:typeof runU3Sql=async(_scope,raw)=>{
 const p=u3SqlSchema.parse(raw);
 const plan=await admitU3Sql(p.sql,Object.keys(relations),p.parameters?.length??0,false,[],{},relations);
 const db=new DatabaseSync(":memory:");
 try{
  db.exec("CREATE TABLE daily_rollups(business_date TEXT PRIMARY KEY,net_sales_cents INTEGER,staff_wages_cents INTEGER,staff_tax_cents INTEGER,labor_wage_status TEXT);"+
   "CREATE TABLE menu_items(id TEXT PRIMARY KEY,name TEXT,is_active INTEGER,price_cents INTEGER);"+
   "CREATE TABLE recipe_lines(menu_item_id TEXT,ingredient_id TEXT,quantity INTEGER);"+
   "CREATE TABLE ingredient_prices(ingredient_id TEXT,cost_per_base_unit_micros INTEGER);"+
   "CREATE TABLE orders(id TEXT PRIMARY KEY,business_date TEXT);"+
   "CREATE TABLE order_lines(order_id TEXT,menu_item_id TEXT,quantity INTEGER,voided INTEGER);"+
   "CREATE TABLE inventory_observations(quantity INTEGER,evidence_state TEXT)");
  for(const d of seed.days)db.prepare("INSERT INTO daily_rollups VALUES(?,?,?,?,?)").run(d.date,d.netSalesCents,d.wagesCents,d.staffTaxCents,d.wageStatus);
  db.prepare("INSERT INTO orders VALUES(?,?)").run("fixture-order",seed.days[0].date);
  for(const item of seed.menu){
   db.prepare("INSERT INTO menu_items VALUES(?,?,?,?)").run(item.id,item.name,item.active?1:0,item.priceCents);
   db.prepare("INSERT INTO recipe_lines VALUES(?,?,?)").run(item.id,item.id,1);
   db.prepare("INSERT INTO ingredient_prices VALUES(?,?)").run(item.id,item.recipeCostCents*1000000);
   db.prepare("INSERT INTO order_lines VALUES(?,?,?,?)").run("fixture-order",item.id,item.unitsOct19,0);
  }
  // SQLite accepts PostgreSQL-style $n as named parameters.
  const statement=db.prepare(p.sql);
  const binds=Object.fromEntries((p.parameters??[]).map((x,i)=>["$"+(i+1),typeof x==="boolean"?Number(x):x]));
  const rows=Object.keys(binds).length?statement.all(binds):statement.all();
  return {source:"u3_canonical_research",period:p.date_from&&p.date_to?{from:p.date_from,to:p.date_to}:null,
   missing:[],rows,truncated:false,page_complete:true,rowCount:rows.length,
   evidence:{scope:"verified_owner_cafe_lease",authority:"approved_logical_source",receipt_id:randomUUID(),
    query_fingerprint:createHash("sha256").update(p.sql).digest("hex"),catalog_version:"a".repeat(16),
    relation_names:plan.relations,column_units:plan.outputUnits,column_origins:plan.outputOrigins}} as Awaited<ReturnType<typeof runU3Sql>>;
 }finally{db.close();}
};
const allowedTools:AgentToolName[]=["describe_data","query_data","calculate"];
const context=():AgentToolContext=>({
 tools:{} as AgentToolContext["tools"],locale:"en",asOf:seed.profile.asOf,timezone:seed.profile.timezone,
 currency:seed.profile.currency,canonicalData:async()=>({businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",db:{} as never,testSqlTransport:readSql}),
});
/**
 * Recorded Responses *model* events drive the real tool loop. Every tool
 * implementation, canonical calculation and number guard runs unchanged.
 * This does not measure fresh model behavior or prompt/model quality.
 */
function recordedProvider(replay:ReplayCase):AgentProvider {
  const rounds=[replay.tools,...(replay.followUpTools?[replay.followUpTools]:[])];
  let round=0;
  const allIds:string[]=[];
  return async function* (params) {
    round++;
    const input=Array.isArray(params.input)?params.input:[];
    for(const id of allIds){
      if(!input.some((x:unknown)=>!!x&&typeof x==="object"&&
        (x as {type?:string;call_id?:string}).type==="function_call_output"&&
        (x as {call_id?:string}).call_id===id))
        throw new Error("production tool result missing: "+id);
    }
    if(round<=rounds.length){
      if(typeof params.instructions!=="string"||!Array.isArray(params.tools))
        throw new Error("production Supervisor instructions/tools missing");
      for(const [i,call] of rounds[round-1].entries()){
        const offered=params.tools.some((tool:unknown)=>
          !!tool&&typeof tool==="object"&&
          (tool as {name?:string}).name===call.name);
        if(!offered)throw new Error("production tool missing: "+call.name);
        let callArgs=call.args;
        if(call.name==="calculate"){
          const previous=input.filter((x):x is {type:string;call_id:string;output:string}=>!!x&&typeof x==="object"&&(x as {type?:string}).type==="function_call_output");
          const observed=previous.flatMap(x=>{try{return [JSON.parse(x.output)];}catch{return [];}});
          const calc=call.args as {inputs:{tool?:string;path?:string;receipt_id?:string}[]};
          callArgs={...calc,inputs:calc.inputs.map(v=>{
            if(v.tool!=="query_data"||v.receipt_id)return v;
            const column=v.path?.split(".").at(-1);
            const source=observed.findLast(x=>x.source==="u3_canonical_research"&&column&&x.evidence?.column_units?.[column]);
            if(!source?.evidence?.receipt_id)throw Error("Recorded calculation needs observed SQL receipt");
            return {...v,receipt_id:source.evidence.receipt_id};
          })};
        }
        const id="eval-read-"+round+"-"+i;
        allIds.push(id);
        yield {type:"response.output_item.done",item:{
          type:"function_call",name:call.name,
          arguments:JSON.stringify(callArgs),call_id:id,
        }};
      }
    }else if(round===rounds.length+1){
      yield {type:"response.output_text.delta",delta:replay.answer};
    }else throw new Error("unexpected additional Supervisor model call");
    yield {type:"response.completed",response:{usage:{
      input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0},
    }}};
  };
}
export default class SupervisorEvalProvider {
  id() {return "supervisor:real-loop:recorded-responses";}
  async callApi(prompt:string,options:{vars?:Record<string,unknown>}={}) {
    const caseId=String(options.vars?.caseId??"");
    const replay=replays.cases[caseId];
    if(!replay)return {error:"Unknown recorded Supervisor eval case: "+caseId};
    if(prompt.trim()!==replay.question.trim())
      return {error:"Question changed without updating its recorded Responses trace"};
    try {
      const turn=await runAgentTurn({
        ownerText:prompt,context:context(),toolNames:allowedTools,
        provider:recordedProvider(replay),
        cafeProfile:"Evaluation café; use its authenticated currency and timezone.",
      });
      return {output:JSON.stringify({
        answer:turn.text,status:turn.status.status,endReason:turn.endReason,
        results:turn.results,usedTools:turn.tools??[],unverified:turn.unverified,
        usage:turn.usage,
      }),cost:0};
    }catch(error) {
      return {error:"Deterministic Supervisor replay failed: "+
        (error instanceof Error?error.message:"unknown")};
    }
  }
}
