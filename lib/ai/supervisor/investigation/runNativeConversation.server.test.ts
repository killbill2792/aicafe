import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const fixtures=vi.hoisted(()=>{
 const latte16="a0000000-0000-4000-8000-000000000016";
 const latte18="a0000000-0000-4000-8000-000000000018";
 const rows=[{id:latte16,name:"Latte 16 oz",sizeLabel:"16 oz",priceCents:700},
   {id:latte18,name:"Latte 18 oz",sizeLabel:"18 oz",priceCents:750}];
 return {latte16,latte18,rows,invoke:vi.fn(),snapshotReason:"rpc_not_installed",
   sensitivity:"normal" as string};
});
vi.mock("@/lib/metrics/p1Readers.server",()=>({
 authorizedOwnerP1:vi.fn(async()=>({identity:{businessId:"a0000000-0000-4000-8000-000000000999",
   asOf:"2026-10-21",timezone:"America/Los_Angeles",currency:"USD"},tools:{}})),
}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({
 readAuthorizedAtomicP1SourceSnapshot:vi.fn(async()=>({status:"unavailable",reason:fixtures.snapshotReason})),
}));
vi.mock("@/lib/pricing/alexP3Capabilities.server",()=>({buildAlexP3Registrations:()=>[]}));
vi.mock("@/lib/ai/supervisor/p3/operandProjection.server",()=>({projectP1Evidence:()=>({operands:[],bindings:[],choices:[],missing:[]})}));
vi.mock("@/lib/scheduling/oliviaP3Capabilities.server",()=>({buildOliviaP3Registrations:()=>[]}));
vi.mock("@/lib/pricing/alexCapabilities.server",()=>({buildAlexPricingRegistrations:()=>[{}]}));
vi.mock("@/lib/scheduling/oliviaInvestigation.server",()=>({buildOliviaInvestigationRegistration:()=>({})}));
vi.mock("./datasets.server",async original=>({...await original<object>(),buildDatasetRegistration:()=>({})}));
vi.mock("./records.server",()=>({buildRecordsRegistration:()=>({}),recordCollections:()=>[]}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn(async()=>fixtures.rows.map(r=>({
 id:r.id,name:r.name,baseName:"Latte",sizeLabel:r.sizeLabel,
 active:true,priceCents:r.priceCents,
})))}));
vi.mock("@/lib/ai/supervisor/p3/sourceRegistry.server",()=>({
 isRedundantModelRead:()=>false,
 createP3ReadRegistry:()=>({
  discover:()=>[{id:"p3.menu.catalog.v1",purpose:"Read menu catalog product prices and active drink variants",
    sensitivity:fixtures.sensitivity,budgets:{timeoutMs:1000},
    inputJsonSchema:{type:"object",additionalProperties:false,
      properties:{purpose:{type:"string"}},required:["purpose"]}}],
  preflightRead:()=>true,
  invoke:async(_scope:unknown,_id:unknown,_input:unknown,onDispatch?:()=>void)=>{
    onDispatch?.();
    return fixtures.invoke();
  },
 }),
}));
import {runNativeConversationTurn} from "./runNativeConversation.server";
const args=(text:string)=>({text,locale:"en" as const,asOf:"2026-10-21",
 timezone:"America/Los_Angeles",history:[],apiKey:"fake",model:"gpt-4.1-mini"});
const call=(name:string,input:unknown)=>({status:"completed",
 usage:{input_tokens:40,output_tokens:15},
 output:[{type:"function_call",name,call_id:"call_"+name,arguments:JSON.stringify(input)}]});
const answer=(mode:"answer"|"clarify",text:string,factIds:string[]=[],optionIds:string[]=[])=>({
 status:"completed",usage:{input_tokens:40,output_tokens:20},
 output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({mode,text,factIds,optionIds})}]}]});
const successful=()=>({status:"verified",value:fixtures.rows,quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]}});
function transport(...steps:unknown[]){
 const bodies:Record<string,unknown>[]=[];
 let n=0;
 const send=vi.fn(async(_url:string,request:RequestInit)=>{
  const b=JSON.parse(String(request.body)) as Record<string,unknown>;
  expect((b.text as {format:{name:string}}).format.name).toBe("supervisor_conversation");
  expect(b.store).toBe(false);
  bodies.push(b);
  return new Response(JSON.stringify(steps[n++]??answer("answer","I could not retrieve more information.")));
 });
 return {send,bodies};
}
beforeEach(()=>{vi.clearAllMocks();fixtures.snapshotReason="rpc_not_installed";
 fixtures.sensitivity="normal";fixtures.rows[0].name="Latte 16 oz";fixtures.rows[1].name="Latte 18 oz";
 fixtures.invoke.mockImplementation(async()=>successful());});
const discover=call("discover_tools",{query:"menu catalog prices"});
const read=call("read_cafe",{id:"p3.menu.catalog.v1",input:{purpose:"read"}});
describe("native owner conversation without separate review",()=>{
 it("discovers, retrieves, and displays source-bound latte prices without numeric prose tokens",async()=>{
  const t=transport(discover,read,answer("answer","Here is the recorded price.",["f2"]));
  const result=await runNativeConversationTurn(args("What is the price of my latte?"),t.send);
  expect(result.reply.status).toBe("verified");
  expect(result.reply.blocks).toEqual(expect.arrayContaining([
   expect.objectContaining({type:"metric",valueCents:700})]));
  expect(result.usage.modelCallCount).toBe(3);
  expect(t.bodies).toHaveLength(3);
  expect(t.bodies[0].tools).toHaveLength(6);
 });
 it("asks a specific durable clarification with verified latte variant choices",async()=>{
  const t=transport(discover,read,
    answer("clarify","Which latte size would you like to change?",[],[fixtures.latte16,fixtures.latte18]));
  const result=await runNativeConversationTurn(args("Please raise my latte price"),t.send);
  expect(result.reply.status).toBe("requires_owner_input");
  expect(result.reply.ownerInput?.request.writeContext.domain).toBe("menu_proposal");
  expect(result.reply.ownerInput?.request.input.kind).toBe("options");
  expect(result.reply.blocks[0]).toMatchObject({type:"owner_question"});
 });
 it("preserves the model's specific numerical clarification and sourced option labels",async()=>{
  const question="Would you like to increase the 16 oz or 18 oz latte?";
  const t=transport(discover,read,answer("clarify",question,[],[fixtures.latte16,fixtures.latte18]));
  const result=await runNativeConversationTurn(args("Raise my latte price by 10 cents"),t.send);
  expect(result.reply.status).toBe("requires_owner_input");
  const card=result.reply.blocks.find(x=>x.type==="owner_question");
  expect(card?.title.en).toBe(question);
  expect(card?.input.kind).toBe("options");
  if(card?.input.kind==="options")
    expect(card.input.options.map(o=>o.label.en)).toEqual(["Latte 16 oz","Latte 18 oz"]);
 });
 it("shows distinct size choices when database variant rows share the base name",async()=>{
  fixtures.rows[0].name="Latte";
  fixtures.rows[1].name="Latte";
  const t=transport(discover,read,
    answer("clarify","Would you like the 16 oz or 18 oz latte?",[],[fixtures.latte16,fixtures.latte18]));
  const result=await runNativeConversationTurn(args("Raise my latte price by 10 cents"),t.send);
  const card=result.reply.blocks.find(x=>x.type==="owner_question");
  expect(card?.title.en).toBe("Would you like the 16 oz or 18 oz latte?");
  if(card?.input.kind==="options")
    expect(card.input.options.map(o=>o.label.en)).toEqual(["Latte · 16 oz","Latte · 18 oz"]);
 });
 it("keeps a natural fact-grounded explanation without inserting boilerplate",async()=>{
  const t=transport(discover,read,
    answer("answer","Your 16 oz latte is recorded at $7.00.",["f2"]));
  const result=await runNativeConversationTurn(args("What is the 16 oz latte price?"),t.send);
  expect(result.reply.status).toBe("verified");
  expect(result.reply.blocks).toEqual(expect.arrayContaining([
    expect.objectContaining({type:"text",text:"Your 16 oz latte is recorded at $7.00."}),
    expect.objectContaining({type:"metric",valueCents:700})]));
 });
 it("uses exact server-calculated cents for ten percent, not a model-written number",async()=>{
  const calculate=call("calculate_verified",{operation:"percent_increase",leftFactId:"f2",
    leftOwnerQuote:null,rightFactId:null,rightOwnerQuote:"10%"});
  const t=transport(discover,read,calculate,answer("answer","Here is the proposed new price.",["f5"]));
  const result=await runNativeConversationTurn(args("Raise the latte by 10%"),t.send);
  expect(result.reply.blocks).toEqual(expect.arrayContaining([
    expect.objectContaining({type:"metric",valueCents:770})]));
  expect(result.usage.toolCallCount).toBeGreaterThanOrEqual(2);
 });
 it("does not accept an unsupported model-written numeric answer",async()=>{
  const t=transport(discover,read,answer("answer","Your price is $999.",["f2"]));
  const result=await runNativeConversationTurn(args("What is my latte price?"),t.send);
  const text=result.reply.blocks.filter(x=>x.type==="text").map(x=>x.text).join(" ");
  expect(text).not.toContain("$999");
  expect(result.reply.blocks).toEqual(expect.arrayContaining([
    expect.objectContaining({type:"metric",valueCents:700})]));
 });
 it("blocks financial source reads when authoritative snapshot integrity fails",async()=>{
  fixtures.snapshotReason="invalid_source_snapshot";
  fixtures.sensitivity="financial";
  const t=transport(discover,read,answer("answer","The financial data was not available."));
  const result=await runNativeConversationTurn(args("What are my actual costs?"),t.send);
  expect(fixtures.invoke).not.toHaveBeenCalled();
  expect(result.reply.status).toBe("unavailable");
 });
 it("returns already verified facts after a provider disconnect instead of an HTTP failure",async()=>{
  const t=transport(discover,read);
  const send=vi.fn(async(url:string,request:RequestInit)=>{
    if(t.send.mock.calls.length>=2)throw new Error("network disconnected");
    return t.send(url,request);
  });
  const result=await runNativeConversationTurn(args("What is my latte price?"),send);
  expect(result.reply.status).toBe("partial");
  expect(result.reply.blocks).toEqual(expect.arrayContaining([
    expect.objectContaining({type:"metric",valueCents:700})]));
  expect(send).toHaveBeenCalledTimes(3);
 });
 it("does not transform a missing data result into an owner clarification",async()=>{
  fixtures.invoke.mockResolvedValue({status:"unavailable",value:null,reason:"sales_coverage_missing"});
  const t=transport(discover,read,answer("answer","I could not verify the requested information."));
  const result=await runNativeConversationTurn(args("What are my latte sales?"),t.send);
  expect(result.reply.status).toBe("unavailable");
  expect(result.reply.blocks.some(x=>x.type==="owner_question")).toBe(false);
 });
});
