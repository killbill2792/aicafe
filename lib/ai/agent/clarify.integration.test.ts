import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import {newResolveState} from "./resolve";
import {proposalTools} from "./tools/proposals";
import type {AgentToolContext} from "./tools";
const hot="11111111-1111-4111-8111-111111111111",iced="22222222-2222-4222-8222-222222222222";
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const catalog=[{id:hot,name:"Latte",category:"drink" as const,active:true,priceCents:450},
{id:iced,name:"Latte",category:"drink" as const,active:true,priceCents:500}];
function context(proposePriceChange=vi.fn()){
 return {asOf:"2026-10-24",locale:"en" as const,timezone:"America/Los_Angeles",
  canonicalData:async()=>({businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",db:{} as never}),
  tools:{getMenuCatalog:async()=>({available:true as const,value:catalog,quality}),
   getProfitability:async()=>({available:false as const,value:null,quality:{...quality,missingInputs:["unavailable"]}}),
   getSalesTrend:async()=>({available:false as const,value:null,quality:{...quality,missingInputs:["unavailable"]}})},
  proposals:{proposePriceChange}} as AgentToolContext;
}

// Mock only the database transport in recorded provider tests. The actual
// general research declaration, dispatch, grounding and loop remain active.
vi.mock("./tools/u3SqlResearch.server",async importOriginal=>{
 const actual=await importOriginal<typeof import("./tools/u3SqlResearch.server")>();
 return {...actual,u3SqlConfigured:()=>true,runU3Sql:async()=>({
  source:"u3_canonical_research",period:null,missing:[],rows:[{"id":"11111111-1111-4111-8111-111111111111","name":"Latte","price_cents":450},{"id":"22222222-2222-4222-8222-222222222222","name":"Latte","price_cents":500}],
  empty:false,truncated:false,page_complete:true,
  evidence:{receipt_id:"11111111-1111-4111-8111-111111111111",scope:"verified_owner_cafe_lease",
   query_fingerprint:"a".repeat(64),catalog_version:"a".repeat(16),column_units:{price_cents:"cents"},
   column_origins:{name:{relation:"menu_items",column:"name",binding:1},price_cents:{relation:"menu_items",column:"price_cents",binding:1}},
   relation_names:["menu_items"]}})};
});

const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:5}}};
const call=(name:string,args:unknown,id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id:id}});
function providerFrom(rounds:unknown[][]){
 const requests:unknown[]=[];
 const provider:AgentProvider=async function*(request){
  requests.push(request);
  for(const e of rounds[requests.length-1]??[])yield e as never;
 };
 return {provider,requests};
}
describe("two-latte owner clarification",()=>{
 it("rejects an ambiguous proposal, then persists one trusted card and stops the model",async()=>{
  const make=vi.fn();
  const ctx=context(make);
  const {provider,requests}=providerFrom([
   [call("query_data",{"view":null,"sql":"SELECT name,price_cents FROM menu_items ORDER BY id","parameters":null,"columns":null,"filters":null,"group_by":null,"metrics":null,"date_from":null,"date_to":null,"order_by":null,"limit":null},"menu-1"),completed],
   [call("propose_price_change",{product_id:hot,new_price_cents:550},"write-2"),completed],
   [call("ask_owner",{question:"Which Latte should cost $5.50?",options:[
    {label:"Latte — drink · 4.50",value:hot},
    {label:"Latte — drink · 5.00",value:iced}],allowOther:true},"ask-3"),completed],
  ]);
  const turn=await runAgentTurn({ownerText:"raise latte price to $5.50",context:ctx,provider});
  expect(requests).toHaveLength(3);
  expect(turn.endReason).toBe("complete");
  expect(make).not.toHaveBeenCalled();
  expect(turn.results[0]).toMatchObject({source:"u3_canonical_research",rows:expect.arrayContaining([expect.objectContaining({id:hot}),expect.objectContaining({id:iced})])});
  expect(turn.results[1]).toMatchObject({source:"price_change_proposal",missing:["ownerChoiceRequired"]});
  expect(turn.results[2]).toMatchObject({source:"ask_owner",missing:[]});
  const persisted=agentReplyPayload(turn);
  const clarify=persisted.reply.blocks.filter(block=>block.type==="clarify");
  expect(clarify).toHaveLength(1);
  expect(persisted.reply.blocks).toHaveLength(1);
  expect(persisted.reply.status).toBe("requires_owner_input");
 });
 it("allows the selected real id only after the next owner message",async()=>{
  const make=vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
   productName:"Latte",oldPriceCents:500,newPriceCents:550,revision:1});
  const ctx=context(make);
  ctx.resolveState=newResolveState("Latte — drink · 5.00",[
    {role:"assistant",content:"Asked: Which Latte? Options: Latte — drink · 4.50 ("+hot+"); Latte — drink · 5.00 ("+iced+")"}]);
  const result=await proposalTools.propose_price_change.execute({product_id:iced,new_price_cents:550},ctx);
  expect(result.missing).toEqual([]);
  expect(make).toHaveBeenCalledTimes(1);
 });
});
