import {describe,it,expect,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import type {AgentToolContext} from "./tools";
import {agentReplyPayload} from "./persist.server";
const completed={type:"response.completed",response:{usage:{
 input_tokens:100,output_tokens:25,input_tokens_details:{cached_tokens:0}}}};
const call=(name:string,args:string,id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:args,call_id:id}});
const text=(delta:string)=>({type:"response.output_text.delta",delta});
const ingredientId="11111111-1111-4111-8111-111111111111";
const args=(quantity:number)=>JSON.stringify({items:[{
 ingredientId,itemName:"Milk",quantity,unit:"gal"}],
 neededBy:"2026-11-17",preferredSupplier:null});
const proposalArgs=(quantity:number,replaceProposalId:string|null=null)=>
 JSON.stringify({...JSON.parse(args(quantity)),replaceProposalId});
const plan={offers:[{supplierName:"Farm A",currency:"CAD",subtotalCents:2250,
 totalCents:null,shippingCents:null,taxCents:null,limitations:["shipping_unknown","tax_unknown"],
 lines:[{quoteId:"22222222-2222-4222-8222-222222222222",ingredientId,
 itemName:"Milk",neededBaseQuantity:18927.05892,baseUnit:"ml",packs:5,
 packQuantity:1,packUnit:"gal",priceCents:450,lineSubtotalCents:2250,
 quotedOn:"2026-11-13",deliveryOn:"2026-11-16"}]}],
 missing:[],comparison:"subtotal_only",truncated:false} as const;
function playback(rounds:Array<Array<Record<string,unknown>>>){
 const requests:Array<Record<string,unknown>>=[];
 const provider:AgentProvider=async function* (params){
  requests.push(params as Record<string,unknown>);
  for(const event of rounds[requests.length-1]??[])yield event as never;
 };
 return {provider,requests};
}
const baseContext={
 locale:"en" as const,asOf:"2026-11-13",timezone:"America/Los_Angeles",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{
   level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{
   level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{
   level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 },
};
describe("Task14B agentic purchasing: Supervisor works through a goal, not Q&A",()=>{
 it("makes multiple actual model-directed tool calls: investigate → persist approval draft → report limitation",async()=>{
  const order:string[]=[];
  const inspect=vi.fn(async()=>{order.push("inspect");return plan;});
  const propose=vi.fn(async()=>{order.push("propose");return {
   proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,supplierName:"Farm A",subtotalCents:2250,currency:"CAD"};});
  const ctx={...baseContext,purchasing:{inspect,propose}} as unknown as AgentToolContext;
  const {requests,provider}=playback([
   [call("inspect_supplier_purchase",args(5),"inspect-1"),completed],
   [call("propose_supplier_purchase_order",proposalArgs(5),"propose-2"),completed],
   [text("I investigated the quoted milk supply and prepared a CAD 22.50 subtotal draft. Shipping and tax are unknown; owner approval is still required. I have not ordered or received stock."),completed]
  ]);
  const result=await runAgentTurn({ownerText:"Handle our milk needs for Monday. Find a supplier and prepare the purchase order.",context:ctx,provider});
  expect(requests).toHaveLength(3);
  expect(order).toEqual(["inspect","propose"]);
  expect(inspect).toHaveBeenCalledWith(JSON.parse(args(5)));
  expect(propose).toHaveBeenCalledWith(JSON.parse(proposalArgs(5)));
  expect(result.text).toContain("owner approval");
  // Full recorded model loop -> trusted tool output -> actual persistence
  // payload. The seeded UI test alone previously missed this essential link.
  expect(agentReplyPayload(result).reply.blocks)
   .toContainEqual({type:"proposal_card",proposalId:"33333333-3333-4333-8333-333333333333"});
  expect((requests[2].input as unknown[]).length).toBeGreaterThan(1);
  expect(requests[0].tools).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"inspect_supplier_purchase",strict:true}),
   expect.objectContaining({name:"propose_supplier_purchase_order",strict:true})
  ]));
 });
 it("persists a future PO after six model-directed tool steps without dropping any domain function",async()=>{
  const steps:string[]=[];
  const inspect=vi.fn(async()=>{steps.push("inspect");return plan;});
  const propose=vi.fn(async()=>{steps.push("propose");return {
   proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,supplierName:"Farm A",subtotalCents:2250,currency:"CAD"};});
  const ctx={...baseContext,purchasing:{inspect,propose}} as unknown as AgentToolContext;
  const {requests,provider}=playback([
   [call("inspect_supplier_purchase",args(5),"inspect-1"),completed],
   [call("inspect_supplier_purchase",args(5),"inspect-2"),completed],
   [call("inspect_supplier_purchase",args(5),"inspect-3"),completed],
   [call("inspect_supplier_purchase",args(5),"inspect-4"),completed],
   [call("inspect_supplier_purchase",args(5),"inspect-5"),completed],
   [call("propose_supplier_purchase_order",proposalArgs(5),"propose-6"),completed],
   [text("Saved one owner-approval PO draft; shipping and taxes are unknown."),completed]
  ]);
  const result=await runAgentTurn({ownerText:"Investigate current milk quotes, then prepare a purchase order for five gallons for my approval.",
   context:ctx,provider});
  expect(requests).toHaveLength(7);
  expect(inspect).toHaveBeenCalledTimes(5);
  expect(propose).toHaveBeenCalledOnce();
  expect(steps).toEqual(["inspect","inspect","inspect","inspect","inspect","propose"]);
  expect(agentReplyPayload(result).reply.blocks)
   .toContainEqual({type:"proposal_card",proposalId:"33333333-3333-4333-8333-333333333333"});
  expect(requests[0].tools).toEqual(expect.arrayContaining([
   expect.objectContaining({name:"inspect_supplier_purchase"}),
   expect.objectContaining({name:"propose_supplier_purchase_order"}),
   expect.objectContaining({name:"get_supplier_purchase_orders"})
  ]));
  expect((requests[0].tools as unknown[]).length).toBeGreaterThan(30);
  expect(requests.every(r=>r.tool_choice==="auto")).toBe(true);
  expect(requests[6].input).toEqual(expect.arrayContaining([
   expect.objectContaining({type:"function_call_output",call_id:"propose-6"})
  ]));
 });
 it("negative draft intent and unrelated wording never trigger hardcoded proposal routing",async()=>{
  const propose=vi.fn();
  const inspect=vi.fn(async()=>plan);
  const ctx={...baseContext,purchasing:{inspect,propose}} as unknown as AgentToolContext;
  const readOnly=playback([
   [call("inspect_supplier_purchase",args(5),"read-only-1"),completed],
   [text("The two saved quotes can be compared, but no draft was requested."),completed]
  ]);
  const compared=await runAgentTurn({ownerText:"Do not create a purchase order; just compare the quotes.",
   context:ctx,provider:readOnly.provider});
  expect(readOnly.requests).toHaveLength(2);
  expect(inspect).toHaveBeenCalledOnce();
  expect(propose).not.toHaveBeenCalled();
  expect(agentReplyPayload(compared).reply.blocks).not.toContainEqual(
   expect.objectContaining({type:"proposal_card"}));
  const unrelated=playback([[text("I can explain how menu items are sorted."),completed]]);
  await runAgentTurn({ownerText:"Explain how to change the display order of menu items.",
   context:{...baseContext} as AgentToolContext,provider:unrelated.provider});
  expect(unrelated.requests).toHaveLength(1);
  expect(unrelated.requests[0].instructions).toEqual(readOnly.requests[0].instructions);
  expect(unrelated.requests[0].tools).toEqual(readOnly.requests[0].tools);
  expect(unrelated.requests[0].tool_choice).toBe("auto");
 });
 it("explicit owner correction lists saved drafts then targets ONLY the selected proposal",async()=>{
  const oldId="55555555-5555-4555-8555-555555555555";
  const proposed:Array<{quantity:number;replaceProposalId:string|null}>=[];
  const list=vi.fn(async()=>({orders:[],truncated:false,drafts:[{
   id:oldId,revision:1,supplierName:"Farm A",itemNames:["Milk"],subtotalCents:2250,currency:"CAD"
  }],draftsTruncated:false}));
  const propose=vi.fn(async (input:{items:Array<{quantity:number}>;replaceProposalId:string|null})=>{
   proposed.push({quantity:input.items[0].quantity,replaceProposalId:input.replaceProposalId});
   return {proposalId:"44444444-4444-4444-8444-444444444444",
    revision:1,supplierName:"Farm A",subtotalCents:3150,currency:"CAD"};
  });
  const ctx={...baseContext,purchasing:{
   list,inspect:vi.fn(async()=>({...plan,offers:[{...plan.offers[0],subtotalCents:3150}]})),propose
  }} as unknown as AgentToolContext;
  const {requests,provider}=playback([
   [call("get_supplier_purchase_orders","{}","list-original"),completed],
   [call("inspect_supplier_purchase",args(7),"inspect-corrected"),completed],
   [call("propose_supplier_purchase_order",proposalArgs(7,oldId),"propose-corrected"),completed],
   [text("I replaced only the selected milk draft with seven gallons. It remains unapproved."),completed],
  ]);
  const corrected=await runAgentTurn({ownerText:"Change that milk draft to seven gallons.",context:ctx,provider});
  expect(agentReplyPayload(corrected).reply.blocks)
   .toContainEqual({type:"proposal_card",proposalId:"44444444-4444-4444-8444-444444444444"});
  expect(requests).toHaveLength(4);
  expect(list).toHaveBeenCalledOnce();
  expect(proposed).toEqual([{quantity:7,replaceProposalId:oldId}]);
  expect(propose).toHaveBeenCalledOnce();
  expect(Object.hasOwn(ctx,"approve")).toBe(false);
 });
 it("refreshes a stale quote with new evidence and a NEW approval draft, never a replay",async()=>{
  const steps:string[]=[];
  const list=vi.fn(async()=>{steps.push("list");return {orders:[],truncated:false,
   drafts:[],draftsTruncated:false};});
  const inspect=vi.fn(async()=>{steps.push("inspect");return plan;});
  const propose=vi.fn(async(input:{replaceProposalId:string|null})=>{
   steps.push("propose");
   expect(input.replaceProposalId).toBe(null);
   return {proposalId:"88888888-8888-4888-8888-888888888888",
    revision:1,supplierName:"Farm A",subtotalCents:2250,currency:"CAD"};
  });
  const ctx={...baseContext,purchasing:{list,inspect,propose}} as unknown as AgentToolContext;
  const {provider}=playback([
   [call("get_supplier_purchase_orders","{}","status-1"),completed],
   [call("inspect_supplier_purchase",args(5),"fresh-evidence-2"),completed],
   [call("propose_supplier_purchase_order",proposalArgs(5,null),"fresh-draft-3"),completed],
   [text("I inspected current quotes and saved a new milk order for your approval. The stale approval remains closed; I did not retry the old order."),completed]
  ]);
  const outcome=await runAgentTurn({ownerText:"The old milk order expired. Refresh the quotes and prepare a new approval.",
   context:ctx,provider});
  expect(steps).toEqual(["list","inspect","propose"]);
  expect(propose).toHaveBeenCalledWith(JSON.parse(proposalArgs(5,null)));
  expect(outcome.text).toContain("new milk order");
  expect(Object.hasOwn(ctx,"approve")).toBe(false);
 });
 it("a SEPARATE flour order containing 'increase' leaves a pending milk draft untouched",async()=>{
  const flourId="77777777-7777-4777-8777-777777777777";
  const flourArgs=JSON.stringify({items:[{ingredientId:flourId,itemName:"Flour",
   quantity:10,unit:"kg"}],neededBy:"2026-11-17",preferredSupplier:null});
  const flourProposal=JSON.stringify({...JSON.parse(flourArgs),replaceProposalId:null});
  const propose=vi.fn(async()=>({proposalId:"66666666-6666-4666-8666-666666666666",
   revision:1,supplierName:"Farm B",subtotalCents:900,currency:"CAD"}));
  const list=vi.fn(async()=>({orders:[],truncated:false,drafts:[{
    id:"55555555-5555-4555-8555-555555555555",revision:1,
    supplierName:"Farm A",itemNames:["Milk"],subtotalCents:2250,currency:"CAD"
   }],draftsTruncated:false}));
  const flourPlan={...plan,offers:[{...plan.offers[0],supplierName:"Farm B",
   subtotalCents:900,lines:[{...plan.offers[0].lines[0],ingredientId:flourId,
     itemName:"Flour",neededBaseQuantity:10000,baseUnit:"g",
     packs:10,packQuantity:1,packUnit:"kg",priceCents:90,lineSubtotalCents:900}]}]};
  const ctx={...baseContext,purchasing:{inspect:vi.fn(async()=>flourPlan),propose,list}} as unknown as AgentToolContext;
  const {provider}=playback([
   [call("get_supplier_purchase_orders","{}","list-before-new"),completed],
   [call("inspect_supplier_purchase",flourArgs,"inspect-separate"),completed],
   [call("propose_supplier_purchase_order",flourProposal,"propose-separate"),completed],
   [text("I prepared a separate flour order and left the milk draft untouched."),completed]
  ]);
  await runAgentTurn({ownerText:"Prepare a separate flour order to increase pastry production.",context:ctx,provider});
  expect(list).toHaveBeenCalledOnce();
  expect(propose).toHaveBeenCalledWith(JSON.parse(flourProposal));
 });
});