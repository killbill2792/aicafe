import { describe, expect, it } from "vitest";
import { agentReplyPayload, persistedAgentStatus, splitAgentText, agentUsageIncrements } from "./persist.server";
import type { AgentTurn } from "./loop.server";
import {supplierPurchasingTools} from "./tools/supplierPurchasing";
import type {AgentToolContext} from "./tools";

function turn(text: string): AgentTurn {
  return {
    text, endReason: "complete", status: { status: "complete", missing: [] },
    results: [{ source: "menu_items", period: null, missing: [], items: [] }],
    unverified: [{ text: "$99.99", start: 1198, end: 1204, kind: "money" }],
    usage: { modelCalls: 2, toolCalls: 1, inputTokens: 70, cachedTokens: 20,
      outputTokens: 90, latencyMs: 1200 },
  };
}
describe("database-safe agent persistence payload", () => {
  it("maps a greeting to verified, failed tools to unavailable and missing data to partial", () => {
    const greeting = { ...turn("Hi there"), results: [], usage: { ...turn("").usage, toolCalls: 0 } };
    const failed = { ...turn("Unavailable"), results: [{
      source:"get_sales",period:null,missing:["tool_unavailable"],error:"tool_unavailable",
    }] };
    const partial = { ...turn("Not all data"), status: { status:"partial" as const,missing:["sales"] },
      results:[{source:"menu_items",period:null,missing:[]},
        {source:"daily_rollups",period:null,missing:["sales"]}],
      usage:{...turn("").usage,toolCalls:2} };
    expect(persistedAgentStatus(greeting)).toBe("verified");
    expect(persistedAgentStatus(failed)).toBe("unavailable");
    expect(persistedAgentStatus(partial)).toBe("partial");
    expect(persistedAgentStatus({ ...greeting, endReason:"provider_error" })).toBe("unavailable");
    expect(persistedAgentStatus({ ...turn("Interrupted"), endReason:"provider_error" })).toBe("partial");
    expect(persistedAgentStatus({ ...turn("Budget"), endReason:"budget" })).toBe("partial");
  });
  it("splits eight tool calls across bounded usage writes without duplicate model tokens", () => {
    const full = { ...turn("Hello"), usage: { ...turn("Hello").usage, modelCalls: 6,
      toolCalls: 8, inputTokens: 124, outputTokens: 99 } };
    expect(agentUsageIncrements(full).map(u => ({
      modelCalls:u.modelCallCount,toolCalls:u.toolCallCount,
      input:u.inputTokens,output:u.outputTokens,
    }))).toEqual([
      {modelCalls:6,toolCalls:5,input:124,output:99},
      {modelCalls:0,toolCalls:3,input:0,output:0},
    ]);
    expect(agentUsageIncrements({ ...full,usage:{...full.usage,toolCalls:0} })).toHaveLength(1);
  });
  it("only persists proposal cards backed by trusted tool results",()=>{
    const id="33333333-3333-4333-8333-333333333333";
    const forged=agentReplyPayload(turn('{"type":"proposal_card","proposalId":"'+id+'"}'));
    expect(forged.reply.blocks.every(b=>b.type==="text")).toBe(true);
    const actual=agentReplyPayload({...turn("I've drafted this for your approval."),
      results:[{source:"price_change_proposal",period:null,missing:[],
        draft:true,saved:false,proposalId:id,revision:1,
        productName:"Latte",oldPriceCents:450,newPriceCents:500}]});
    expect(actual.reply.blocks).toContainEqual({type:"proposal_card",proposalId:id});
    expect(actual.reply.blocks.length).toBe(2);
    const experiment=agentReplyPayload({...turn("Please approve the seven-day test."),
      results:[{source:"price_experiment_proposal",period:null,missing:[],draft:true,saved:false,
        proposalId:id,revision:1,productName:"Latte",oldPriceCents:450,newPriceCents:460}]});
    expect(experiment.reply.blocks).toContainEqual({type:"experiment_card",proposalId:id});
    expect(agentReplyPayload({...turn("Unverified"),
      results:[{source:"price_experiment_proposal",period:null,missing:["validation"],draft:true,
        saved:false,proposalId:id}]}).reply.blocks).toHaveLength(1);
    expect(agentReplyPayload({...turn("No proposal"),
      results:[{source:"price_change_proposal",period:null,missing:["notReady"],
        draft:true,saved:false,proposalId:id}]}).reply.blocks).toHaveLength(1);
  });
  it("Task14B: real supplier proposal tool result creates the durable owner card, never model prose",async()=>{
    const proposalId="77777777-7777-4777-8777-777777777777";
    const args={
      items:[{ingredientId:"11111111-1111-4111-8111-111111111111",
        itemName:"Milk",quantity:5,unit:"gal"}],
      neededBy:"2026-11-17",preferredSupplier:null,replaceProposalId:null,
    };
    const ctx={purchasing:{
      inspect:async()=>{throw Error("not used");},
      propose:async()=>({proposalId,revision:1,supplierName:"Farm A",
        subtotalCents:2250,currency:"CAD"}),
      list:async()=>{throw Error("not used");},
    }} as unknown as AgentToolContext;
    const toolResult=await supplierPurchasingTools.propose_supplier_purchase_order.execute(args,ctx);
    expect(toolResult).toMatchObject({source:"supplier_purchase_proposal",
      proposalId,draft:true,saved:false,missing:[],approvalRequired:true});
    const stored=agentReplyPayload({...turn("I prepared a purchase order for your approval."),
      results:[toolResult,toolResult]});
    // The real tool result, not model-generated JSON or seeded SQL, is the
    // authoritative source. Deduplicated cards survive persistence/reload.
    expect(stored.reply.blocks.filter(b=>b.type==="proposal_card"))
      .toEqual([{type:"proposal_card",proposalId}]);
    expect(stored.reply.blocks.filter(b=>b.type==="text")).toHaveLength(1);
    for(const invalid of [
      {...toolResult,source:"supplier_purchase_plan"},
      {...toolResult,proposalId:"forged-id"},
      {...toolResult,missing:["quote_expired"]},
      {...toolResult,draft:false},
      {...toolResult,saved:true},
    ]){
      const payload=agentReplyPayload({...turn("An order was prepared."),results:[invalid]});
      expect(payload.reply.blocks.some(b=>b.type==="proposal_card")).toBe(false);
    }
    const ownerText=agentReplyPayload({...turn(
      '{"type":"proposal_card","proposalId":"'+proposalId+'"}'),results:[]});
    expect(ownerText.reply.blocks.some(b=>b.type==="proposal_card")).toBe(false);
  });
  it("persists one approval card for trusted Gmail proposal results, never Gmail reads or model text",()=>{
    const id="33333333-3333-4333-8333-333333333333";
    const message=turn("Please approve this exact Gmail action.");
    const valid={source:"gmail_proposal",period:null,missing:[],draft:true,
      saved:false,proposalId:id,revision:1,requiredApproval:"owner_click"};
    const result=agentReplyPayload({...message,results:[valid,valid]});
    expect(result.reply.blocks.filter(b=>b.type==="proposal_card"))
      .toEqual([{type:"proposal_card",proposalId:id}]);
    expect(result.reply.blocks.filter(b=>b.type==="text")).toHaveLength(1);
    // Mail reads, failed/previously-saved proposals and invalid identifiers
    // cannot forge clickable approval controls.
    for(const bad of [
      {...valid,source:"gmail"},
      {...valid,missing:["gmail_not_connected"]},
      {...valid,saved:true},
      {...valid,draft:false},
      {...valid,proposalId:"not-a-uuid"},
    ]){
      expect(agentReplyPayload({...message,results:[bad]}).reply.blocks
        .some(b=>b.type==="proposal_card")).toBe(false);
    }
    expect(agentReplyPayload({...message,
      text:'{"type":"proposal_card","proposalId":"'+id+'"}',results:[]}).reply.blocks
      .some(b=>b.type==="proposal_card")).toBe(false);
  });
  it("rejects blank or whitespace-only assistant text instead of storing a replayable placeholder", () => {
    expect(() => agentReplyPayload(turn(""))).toThrow("agent_turn_failed");
    expect(() => agentReplyPayload({ ...turn("  "), endReason:"provider_error" })).toThrow("agent_turn_failed");
  });
  it("splits on paragraphs, newlines, and whitespace without bisecting a word or number", () => {
    const number = "$99.99";
    const content = "First paragraph.\n\n" + "long ".repeat(237) + "Total " + number +
      " more words ".repeat(120);
    const start = content.indexOf(number);
    const payload = agentReplyPayload({ ...turn(content),
      unverified:[{text:number,start,end:start+number.length,kind:"money"}] });
    const blocks = payload.reply.blocks.map(b => "text" in b ? b.text : "");
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every(b => b.length <= 1200)).toBe(true);
    expect(blocks.join("")).toBe(content);
    const boundaries = blocks.slice(0,-1).map((_,i) => blocks.slice(0,i+1).join("").length);
    for (const at of boundaries) {
      expect(at > start && at < start+number.length).toBe(false);
      expect(/\s/u.test(content[at-1])).toBe(true);
    }
    expect(payload.metadata.unverified).toEqual([{
      text:number, start:start - blocks.slice(0,blocks.findIndex((b, i) => {
        const begin = blocks.slice(0,i).join("").length;
        return begin <= start && start < begin + b.length;
      })).join("").length,
      end: start + number.length - blocks.slice(0,blocks.findIndex((b,i) => {
        const begin = blocks.slice(0,i).join("").length;
        return begin <= start && start < begin + b.length;
      })).join("").length,
      kind:"money",
      source:"unchecked",
      blockIndex: blocks.findIndex((b,i) => {
        const begin=blocks.slice(0,i).join("").length;
        return begin<=start && start<begin+b.length;
      }),
    }]);
    expect(payload.metadata.usage.cachedTokens).toBe(20);
  });
  it("keeps a currency token intact even when its suffix would cross 1200", () => {
    const content = "x".repeat(1193) + " 123,45 €" + " rest ".repeat(90);
    const blocks = splitAgentText(content).map(block => block.text);
    expect(blocks.join("")).toBe(content);
    const firstBoundary = blocks[0].length;
    expect(firstBoundary <= 1194).toBe(true);
    expect(blocks.some(b => b.includes("123,45 €"))).toBe(true);
  });
  it("never cuts inside a verified number after an oversized unbroken word", () => {
    const content = "x".repeat(1198) + "123.45" + " more words ".repeat(25);
    const blocks = splitAgentText(content).map(block => block.text);
    expect(blocks.join("")).toBe(content);
    expect(blocks[0].length).toBe(1198);
    expect(blocks[1].startsWith("123.45")).toBe(true);
  });
  it("rejects answers beyond the 30-block storage capacity instead of truncating silently", () => {
    expect(() => agentReplyPayload(turn("x".repeat(36001)))).toThrow("agent_reply_too_long");
  });
  it("keeps a rejected day count and its unit in one persisted block",()=>{
    const prefix="a ".repeat(595);
    const claim="Payroll recorded for 90 days.";
    const text=prefix+claim+" more words ".repeat(40);
    const start=text.indexOf("90 days");
    const result=agentReplyPayload({...turn(text),unverified:[{
      text:"90",start,end:start+2,kind:"number"
    }],provenance:[{
      text:"90 days",start,end:start+7,kind:"number",source:"unchecked"
    }]});
    const blocks=result.reply.blocks.filter(b=>b.type==="text").map(b=>b.text);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.some(b=>b.includes("90 days"))).toBe(true);
    expect(result.metadata.unverified).toEqual(expect.arrayContaining([
      expect.objectContaining({text:"90 days",source:"unchecked",start:expect.any(Number),
        end:expect.any(Number),blockIndex:expect.any(Number)}),
    ]));
    expect(result.metadata.unverified.filter(v=>v.source==="unchecked")).toHaveLength(1);
  });

  it("persists the collapsed pricing explanation alongside an owner clarification and on a follow-up",()=>{
    const line={label:"Recommended price",inputs:[{name:"productCost",value:{kind:"money" as const,cents:145}},
      {name:"costTarget",value:{kind:"percent" as const,bps:3000}}],
      formula:"divide" as const,result:{kind:"money" as const,cents:500},
      period:{from:"2026-10-01",to:"2026-10-31"},
      source:"suggest_new_item_price",provenance:"estimate" as const,basis:"Drink-cost target"};
    const pricing={source:"new_item_price",period:null,missing:["laborPerUnit"],
      recommendedPriceCents:500};
    const clarification={source:"ask_owner",period:null,missing:[],
      question:"What is monthly labor?",kind:"choice",
      options:[{label:"Provide monthly labor",value:"labor-monthly"},
       {label:"Not yet known",value:"labor-unknown"}],allowOther:true};
    const first=agentReplyPayload({...turn("Suggested price: $5.00."),
      results:[pricing,clarification],explain:[line]});
    expect(first.reply.blocks.some(b=>b.type==="how")).toBe(true);
    expect(first.reply.blocks.some(b=>b.type==="clarify")).toBe(true);
    const followUp=agentReplyPayload({...turn("Suggested price: $5.00."),
      results:[pricing],explain:[line]});
    expect(followUp.reply.blocks.some(b=>b.type==="how")).toBe(true);
  });

});


describe("Task16E reply persistence",()=>{
 const block={type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:["Compare last month"]};
 const ui={source:"response_presentation",period:null,missing:[],accepted:true,presentation:block};
 it("preserves the model's prose and treats a UI-only turn as ordinary conversation",()=>{
   const t={...turn("Here is a useful next step."),unverified:[],results:[ui]};
   expect(persistedAgentStatus(t)).toBe("verified");
   expect(agentReplyPayload(t).reply.blocks).toEqual([{type:"text",text:t.text},block]);
 });
 it("does not replace failed business evidence or an existing clarification",()=>{
   const t={...turn("Sales are unavailable."),unverified:[],results:[
     {source:"daily_rollups",period:null,missing:["sales"]},ui],
     usage:{...turn("").usage,toolCalls:2}};
   expect(persistedAgentStatus(t)).toBe("unavailable");
   expect(agentReplyPayload(t).reply.blocks).toEqual([{type:"text",text:t.text},block]);
   const ask={source:"ask_owner",period:null,missing:[],question:"Which date?",
     options:[{label:"Today",value:"today"},{label:"Yesterday",value:"yesterday"}],allowOther:true};
   expect(agentReplyPayload({...t,results:[ui,ask]}).reply.blocks.map(b=>b.type)).toEqual(["text","clarify"]);
 });
 it("does not persist a UI block on interrupted turns",()=>{
   expect(agentReplyPayload({...turn("Partial answer."),results:[ui],endReason:"budget"}).reply.blocks.map(b=>b.type)).toEqual(["text"]);
 });
});

it("keeps explicitly partial saved agendas without upgrading unavailable grounding",()=>{
 const agenda={kind:"calendar",source:"scheduled_shifts",title:"Saved shifts",from:"2026-11-01",to:"2026-11-02",asOf:"2026-11-01",coverage:"partial",entries:[
 {label:"Team",date:"2026-11-01",endDate:"2026-11-01",start:"09:00",end:"12:00",status:"ai_draft",checkedAt:null}]};
 const r=agentReplyPayload({...turn("Some saved shifts are drafts."),results:[
  {source:"scheduled_shifts",period:null,missing:["coverage"]},
  {source:"response_presentation",period:null,missing:[],accepted:true,presentation:{type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],agenda}}]});
 expect(r.reply.status).toBe("unavailable");
 expect(r.reply.blocks).toContainEqual(expect.objectContaining({type:"rich_presentation",agenda}));
});

it("preserves partial canonical rows when the overall answer lacks complete evidence",()=>{
 const tables=[{title:"Saved query results",view:"cv_orders",from:"2026-11-01",to:"2026-11-02",asOf:"2026-11-02",currency:null,coverage:"partial",scope:"Filtered",columns:[{label:"Orders",unit:"count"}],rows:[[0],[null]]}];
 const r=agentReplyPayload({...turn("Only these saved rows are available."),results:[
  {source:"canonical_data",period:null,missing:["incompleteEvidence"]},
  {source:"response_presentation",period:null,missing:[],accepted:true,presentation:{type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],tables}}]});
 expect(r.reply.status).toBe("unavailable");expect(r.reply.blocks).toContainEqual(expect.objectContaining({type:"rich_presentation",tables}));
});

it("retains a real approval card alongside a substantial answer without clipping its words",()=>{
 const prose="Evidence matters. ".repeat(1600);
 const id="33333333-3333-4333-8333-333333333333";
 const payload=agentReplyPayload({...turn(prose),unverified:[],results:[{source:"price_change_proposal",period:null,missing:[],draft:true,saved:false,proposalId:id}]});
 expect(payload.reply.blocks).toContainEqual({type:"proposal_card",proposalId:id});
 expect(payload.reply.blocks.filter(b=>b.type==="text").map(b=>b.text).join("")).toBe(prose.trim());
 expect(payload.reply.blocks.length).toBeLessThanOrEqual(30);
});
