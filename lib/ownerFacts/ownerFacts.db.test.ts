import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
import {runResearchTurn} from "@/lib/ai/research/turn.server";
import {formatSavedOwnerFacts,type SavedFact} from "./inject";

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
  const fact=facts.find(f=>f.fact_key==="milk_almond_serving_cost_cents:16oz")!;
  const savedContext=formatSavedOwnerFacts(facts);
  let calls=0;
  const provider:AgentProvider=async function*(params){
   expect(JSON.stringify(params.input)).toContain(fact.fact_key);
   expect(JSON.stringify(params.input)).toContain(String(fact.value_json));
   calls++;
   yield {type:"response.output_text.delta",delta:"You told me almond milk costs "+String(fact.value_json)+" cents per 16 oz serving."};
   yield {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[]}};
   yield {type:"response.completed",response:{usage:{input_tokens:1,output_tokens:1}}};
  };
  const turn=await runResearchTurn({ownerText:"What did I tell you almond milk costs per 16 oz serving?",
   history:[],cafeContext:savedContext,scope:{db:{} as never,businessId:"fixture",ownerUserId:"fixture"},provider});
  expect(turn.endReason).toBe("complete");
  expect(calls).toBe(1);
  expect(turn.tools).not.toContain("ask_owner");
  expect(turn.text).toContain(String(fact.value_json));
  expect(turn.text.toLowerCase()).toContain("almond milk");
 });
});
