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
 return {asOf:"2026-10-24",locale:"en" as const,
  tools:{getMenuCatalog:async()=>({available:true as const,value:catalog,quality}),
   getProfitability:async()=>({available:false as const,value:null,quality:{...quality,missingInputs:["unavailable"]}}),
   getSalesTrend:async()=>({available:false as const,value:null,quality:{...quality,missingInputs:["unavailable"]}})},
  proposals:{proposePriceChange}} as AgentToolContext;
}
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
   [call("get_menu_items",{query:"Latte",limit:8},"menu-1"),completed],
   [call("propose_price_change",{product_id:hot,new_price_cents:550},"write-2"),completed],
   [call("ask_owner",{question:"Which Latte should cost $5.50?",options:[
    {label:"Latte — drink · 4.50",value:hot},
    {label:"Latte — drink · 5.00",value:iced}],allowOther:true},"ask-3"),completed],
  ]);
  const turn=await runAgentTurn({ownerText:"raise latte price to $5.50",context:ctx,provider});
  expect(requests).toHaveLength(3);
  expect(turn.endReason).toBe("complete");
  expect(make).not.toHaveBeenCalled();
  expect(turn.results[0]).toMatchObject({source:"menu_items",needsOwnerChoice:true});
  expect(turn.results[1]).toMatchObject({source:"price_change_proposal",missing:["ownerChoiceRequired"]});
  expect(turn.results[2]).toMatchObject({source:"ask_owner",missing:[]});
  const persisted=agentReplyPayload(turn);
  const clarify=persisted.reply.blocks.filter(block=>block.type==="clarify");
  expect(clarify).toHaveLength(1);
  expect(persisted.reply.blocks).toHaveLength(1);
  expect(persisted.reply.status).not.toBe("requires_owner_input");
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
