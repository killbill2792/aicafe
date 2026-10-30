import {describe,expect,it,vi} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./tools/index";
import {proposalTools} from "./tools/proposals";
import {newResolveState,resolveEntity} from "./resolve";

// Owner report (Oct 29): "raise the latte 10 cents" → picked a latte on the card → what-if
// answer → "draft price change approval" → asked "which latte?" again. The pick was only
// trusted on the message right after the card.
const hot="11111111-1111-4111-8111-111111111111",iced="22222222-2222-4222-8222-222222222222";
const cappuccino="33333333-3333-4333-8333-333333333333";
const menus={
 sameName:[{id:hot,name:"Latte",category:"drink",active:true,priceCents:775},
  {id:iced,name:"Latte",category:"drink",active:true,priceCents:525},
  {id:cappuccino,name:"Cappuccino",category:"drink",active:true,priceCents:500}],
 icedName:[{id:hot,name:"Latte",category:"drink",active:true,priceCents:775},
  {id:iced,name:"Iced Latte",category:"drink",active:true,priceCents:525},
  {id:cappuccino,name:"Cappuccino",category:"drink",active:true,priceCents:500}],
};
type Menu=(typeof menus)[keyof typeof menus];
/** The card exactly as the chat history shows it to the model (agent route). */
function card(menu:Menu){
 const resolved=resolveEntity("product","latte",menu,{nameOf:i=>i.name,idOf:i=>i.id,
  describe:i=>i.category+" · "+(i.priceCents/100).toFixed(2)});
 if(resolved.status!=="ambiguous")throw new Error("fixture must be ambiguous");
 return {labels:resolved.candidates.map(c=>c.label),
  content:"Asked: Which latte? Options: "+resolved.candidates.map(c=>c.label+" ("+c.id+")").join("; ")};
}
function conversation(menu:Menu,afterPick:string[]=[],pick=0){
 const shown=card(menu);
 return [{role:"user" as const,content:"I want to increase the price of latte by 10 cents"},
  {role:"assistant" as const,content:shown.content},
  {role:"user" as const,content:shown.labels[pick]},
  {role:"assistant" as const,content:"This is only a what-if; the price hasn't changed. Want me to draft the price change for your approval?"},
  ...afterPick.flatMap(text=>[{role:"user" as const,content:text},{role:"assistant" as const,content:"Done."}])];
}
function context(menu:Menu,ownerText:string,history:{role:"user"|"assistant";content:string}[]){
 const proposePriceChange=vi.fn().mockResolvedValue({proposalId:"44444444-4444-4444-8444-444444444444",
  revision:1,productName:"Latte",oldPriceCents:775,newPriceCents:785});
 const ctx={timezone:"America/Los_Angeles",asOf:"2026-10-29",locale:"en" as const,
  tools:{getMenuCatalog:async()=>({available:true as const,value:menu,
   quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}})} as unknown as AgentToolContext["tools"],
  proposals:{proposePriceChange},resolveState:newResolveState(ownerText,history)} as unknown as AgentToolContext;
 return {ctx,proposePriceChange};
}

describe("the owner's card pick holds for the rest of that topic",()=>{
 for(const [name,menu] of Object.entries(menus))it(name+": 'draft price change approval' drafts the latte already picked",async()=>{
  const {ctx,proposePriceChange}=context(menu,"draft price change approval",conversation(menu));
  const read=await executeAgentTool("get_menu_items",{query:"latte",limit:null},ctx);
  expect(read.needsOwnerChoice).toBeUndefined();
  expect((read.items as {id:string}[]).map(i=>i.id)).toEqual([hot]);
  const draft=await proposalTools.propose_price_change.execute({product_id:hot,new_price_cents:785},ctx);
  expect(draft).toMatchObject({missing:[],draft:true,saved:false});
  expect(proposePriceChange).toHaveBeenCalledWith({productId:hot,newPriceCents:785});
 });
 for(const [name,menu] of Object.entries(menus))it(name+": the pick never confirms the other latte",async()=>{
  const {ctx,proposePriceChange}=context(menu,"draft price change approval",conversation(menu));
  const draft=await proposalTools.propose_price_change.execute({product_id:iced,new_price_cents:535},ctx);
  expect(draft.missing.length).toBeGreaterThan(0);
  expect(proposePriceChange).not.toHaveBeenCalled();
 });
 it("still holds a few messages later on the same topic",async()=>{
  const menu=menus.icedName;
  const {ctx}=context(menu,"ok draft it now",conversation(menu,["what would that do to my margin?"]));
  const draft=await proposalTools.propose_price_change.execute({product_id:hot,new_price_cents:785},ctx);
  expect(draft.missing).toEqual([]);
 });
 it("is dropped when the owner switches to another option of that card",async()=>{
  const menu=menus.icedName;
  const {ctx,proposePriceChange}=context(menu,"actually do the iced one",conversation(menu));
  const read=await executeAgentTool("get_menu_items",{query:"latte",limit:null},ctx);
  expect(read.needsOwnerChoice).toBe(true);
  const draft=await proposalTools.propose_price_change.execute({product_id:hot,new_price_cents:785},ctx);
  expect(draft.missing.length).toBeGreaterThan(0);
  expect(proposePriceChange).not.toHaveBeenCalled();
 });
 it("is dropped when the owner switches to a shorter option (picked Iced Latte, then 'the regular latte')",async()=>{
  const menu=menus.icedName;
  expect(card(menu).labels[1]).toBe("Iced Latte");
  const {ctx,proposePriceChange}=context(menu,"actually the regular latte, not the iced one",conversation(menu,[],1));
  const read=await executeAgentTool("get_menu_items",{query:"latte",limit:null},ctx);
  expect(read.needsOwnerChoice).toBe(true);
  const draft=await proposalTools.propose_price_change.execute({product_id:iced,new_price_cents:535},ctx);
  expect(draft.missing.length).toBeGreaterThan(0);
  expect(proposePriceChange).not.toHaveBeenCalled();
 });
 it("is dropped when the owner names the item again, so their new words decide",()=>{
  const menu=menus.sameName;
  for(const text of ["draft it for the latte","not that one, the iced latte"])
   expect([...newResolveState(text,conversation(menu)).recentChoiceIds??[]]).toEqual([]);
 });
 it("is dropped when a newer choice card was shown",()=>{
  const menu=menus.sameName;
  const history=[...conversation(menu),{role:"user" as const,content:"who works tomorrow?"},
   {role:"assistant" as const,content:"Asked: Which Maria? Options: Maria (55555555-5555-4555-8555-555555555555); Maria (66666666-6666-4666-8666-666666666666)"}];
  expect([...newResolveState("draft price change approval",history).recentChoiceIds??[]]).toEqual([]);
 });
 it("needs a real pick: typing past the card remembers nothing",()=>{
  const menu=menus.sameName;
  const history=conversation(menu).map((m,i)=>i===2?{...m,content:"never mind, what were sales today?"}:m);
  expect([...newResolveState("draft price change approval",history).recentChoiceIds??[]]).toEqual([]);
 });
 it("does not answer a different item's question",async()=>{
  const menu=menus.sameName;
  const {ctx}=context(menu,"what is the cappuccino price?",conversation(menu));
  const read=await executeAgentTool("get_menu_items",{query:"cappuccino",limit:null},ctx);
  expect((read.items as {id:string}[]).map(i=>i.id)).toEqual([cappuccino]);
 });
});
