import {describe,it,expect} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import type {AgentToolContext} from "./tools";
const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const tool=(name:string,args:unknown,call_id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id}});
const missing={available:false as const,value:null,quality:{level:"low" as const,missingInputs:["x"],estimatedInputs:[],staleInputs:[]}};
const base=():AgentToolContext=>({locale:"en",timezone:"America/Los_Angeles",asOf:"2026-11-04",
 tools:{getMenuCatalog:async()=>missing,getSalesTrend:async()=>missing,getProfitability:async()=>missing}});
const once=(events:unknown[]):AgentProvider=>{let i=0;return async function*(){if(i++===0)for(const e of events)yield e as never;};};
const ownerFacts=[{fact_key:"supplier",value_json:"Mill Street Dairy",unit:null,period_scope:null,created_at:"2026-10-30T09:00:00Z"},
 {fact_key:"monthly_bills_cents",value_json:320000,unit:"cents",period_scope:"month",created_at:"2026-11-01T09:00:00Z"}];
const field=(key:string,inputType:string)=>({key,label:key,inputType,units:[],defaultUnit:"",choices:null,remember:"lasting"});
const ask=(changeSaved:boolean,fields:unknown[])=>tool("ask_owner",{kind:"facts",question:"Change what I remember?",
 options:[],allowOther:false,changeSaved,fields},"q");
const card=(turn:Awaited<ReturnType<typeof runAgentTurn>>)=>
 agentReplyPayload(turn).reply.blocks.find(b=>b.type==="clarify");

describe("the owner can change or forget a saved fact from the chat",()=>{
 it("a change card shows each saved value and date, and offers forget only off-screen facts",async()=>{
  const turn=await runAgentTurn({ownerText:"Change my supplier and bills",context:base(),ownerFacts,
   provider:once([ask(true,[field("supplier","text"),field("monthly_bills_cents","money")]),completed])});
  const block=card(turn);
  expect(clarifyBlockSchema.safeParse(block).success).toBe(true);
  expect(block).toMatchObject({kind:"facts",changeSaved:true,fields:[
   {key:"supplier",current:{value:"Mill Street Dairy",savedOn:"2026-10-30",canForget:true}},
   {key:"monthly_bills_cents",current:{value:"3200.00",savedOn:"2026-11-01",canForget:false}}]});
 });
 it("a change card can never ask for a fact that is not saved",async()=>{
  const turn=await runAgentTurn({ownerText:"Change my rent",context:base(),ownerFacts,
   provider:once([ask(true,[field("rent_note","text")]),completed])});
  expect(turn.results.find(r=>r.source==="ask_owner")).toMatchObject({error:"invalidFactFields"});
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.missing.length===0)).toBe(false);
 });
 it("without a change request, a saved fact is still never asked again",async()=>{
  const turn=await runAgentTurn({ownerText:"Who is our supplier?",context:base(),ownerFacts,
   provider:once([ask(false,[field("supplier","text")]),completed])});
  expect(turn.results.find(r=>r.source==="ask_owner")).toMatchObject({error:"ownerFactAlreadySaved"});
 });
 it("a one-day answer is marked for this question only and stays a valid card",async()=>{
  const turn=await runAgentTurn({ownerText:"Plan for Thursday",context:base(),ownerFacts,
   provider:once([ask(false,[{...field("expected_guests_thursday","number"),remember:"this_question"},
    field("milk_supplier_backup","text")]),completed])});
  const block=card(turn);
  expect(clarifyBlockSchema.safeParse(block).success).toBe(true);
  expect(block).toMatchObject({fields:[{key:"expected_guests_thursday",remember:"this_question"},
   {key:"milk_supplier_backup"}]});
  expect((block as {fields:Record<string,unknown>[]}).fields[1]).not.toHaveProperty("remember");
 });
});
