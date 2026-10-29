import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {runAgentTurn,type AgentProvider} from "@/lib/ai/agent/loop.server";
import type {AgentToolContext} from "@/lib/ai/agent/tools";
import type {SavedFact} from "./inject";

/** Runs the real migration on an isolated local PostgreSQL database.
 * Never connect this fixture to production or any non-loopback host. */
const url=process.env.OWNER_FACTS_DB_URL;
const local=(()=>{
 if(!url)return false;
 try{
  const parsed=new URL(url);
  return ["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname)
    &&parsed.pathname==="/ownerfacts_test";
 }catch{return false;}
})();
const databaseTest=url?it:it.skip;
const context:AgentToolContext={
 asOf:"2026-10-28",timezone:"Etc/UTC",locale:"en",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],
    quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,
    quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,
    quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}})
 }
};
const completed={type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
let turnNumber=0;
const provider:AgentProvider=async function*(){
 if(turnNumber++===0){
  yield {type:"response.output_item.done",item:{type:"function_call",
   name:"milk_swap_price",call_id:"milk-db",arguments:JSON.stringify({
    targetMilk:"almond milk",baseMilk:null,sizes:["16 oz"]
   })}};
 }else{
  yield {type:"response.output_text.delta",
   delta:"Almond milk 16 oz: suggested upcharge $1.70 (estimate)."};
 }
 yield completed;
};
describe("migration 110 disposable PostgreSQL integration",()=>{
 databaseTest("save, supersede, write-through, another cafe RLS, NEW-thread owner-fact reuse",async()=>{
  expect(local,"OWNER_FACTS_DB_URL must target local /ownerfacts_test only").toBe(true);
  const from=(name:string)=>readFileSync(new URL(name,import.meta.url),"utf8");
  const sql=[
   from("dbFixture.schema.sql"),
   readFileSync(new URL("../../supabase/migrations/20261028000110_owner_facts.sql",import.meta.url),"utf8"),
   from("dbFixture.assertions.sql")
  ].join("\n\n");
  const result=execFileSync("psql",["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-d",url!],{
   input:sql,encoding:"utf8",timeout:30000,maxBuffer:1024*1024*4
  });
  const line=result.split(/\r?\n/u).find(v=>v.startsWith("FACTS_JSON="));
  expect(line,"PostgreSQL did not return authenticated current facts").toBeDefined();
  const facts=JSON.parse(line!.slice("FACTS_JSON=".length)) as SavedFact[];
  expect(facts.filter(f=>f.fact_key==="payroll_extras_monthly_cents"))
   .toEqual([expect.objectContaining({value_json:5100})]);
  expect(facts.some(f=>f.fact_key==="milk_almond_serving_cost_cents:16oz")).toBe(true);
  // Different thread, no history: the deterministic chat adapter must reuse
  // the database's actual owner facts and must not ask another question.
  const turn=await runAgentTurn({
   ownerText:"Switch 16 oz latte to almond milk; what upcharge?",
   history:[],context,ownerFacts:facts,provider
  });
  expect(turn.results.filter(r=>r.source==="ask_owner")).toHaveLength(0);
  const milk=turn.results.find(r=>r.source==="milk_swap");
  expect(milk).toMatchObject({missing:[],targetMilk:"almond milk",
   rows:[expect.objectContaining({sizeId:"16oz",inputBasis:"owner_provided",
    suggestedUpchargeCents:expect.any(Number)})]});
  expect(turn.text).toContain("almond milk");
 });
});
