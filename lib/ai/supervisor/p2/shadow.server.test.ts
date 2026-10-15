import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import {
  createP2Registry, schemaFingerprint, type P2Registration, type TrustedReadScope,
} from "./registry";
import { buildP1P2Registrations } from "./p1Adapters.server";
import { runP2ShadowWithScope,createDefaultShadowRegistry } from "./shadow.server";

const period={from:"2026-10-01",to:"2026-10-03"};
const costSummary={
  period,knownTotalCents:400,completeness:"partial" as const,
  components:{ingredientsCents:400,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
  observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false},
  missingInputs:["laborCoverage:0/3"],estimatedInputs:[],
  coverage:{salesDays:1,laborDays:0,expectedDays:3,missingProductCostCount:0,
    itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
    historicalIngredientCostsProven:false,soldProductIds:[],missingProductCostIds:[],
    estimatedProductCostIds:[],missingFeeDays:0,missingOperatingCategories:[]},
};
const args={
  id:"money.business_costs",version:1,purpose:"actual_period_cost_review",period,
};
const scope=(tools:Partial<BusinessScopedCafeTools>={}):TrustedReadScope=>({
  role:"owner",businessId:"cafe-a",shadowEnabled:true,
  identity:{businessId:"cafe-a",asOf:"2026-10-03",
    timezone:"America/Los_Angeles",currency:"USD"},
  tools:tools as BusinessScopedCafeTools,
});
const apiResponse=(body:unknown)=>new Response(JSON.stringify({
  status:"completed",model:"shadow-fixture",
  usage:{input_tokens:42,output_tokens:12},
  output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(body)}]}],
}),{status:200,headers:{"content-type":"application/json"}});
const transport=(audit:unknown,plan?:unknown)=>{
  const calls:unknown[]=[];
  const fn=vi.fn(async(_url:string,init:RequestInit)=>{
    const request=JSON.parse(init.body as string);
    calls.push(request);
    return apiResponse(calls.length===1?audit:plan);
  });
  return {fn,calls};
};
const select=(clauses:string[],choices:Array<{
  capabilityId:string|null;inputJson:string|null;reason:string|null;
}>)=>({complete:true,choices:clauses.map((clause,i)=>({clause,...choices[i]}))});
const request=(goal:string,transportFn:ReturnType<typeof transport>["fn"],
  opts:Partial<Parameters<typeof runP2ShadowWithScope>[0]>={})=>
  runP2ShadowWithScope({
    goal,scope:scope(),registry:createDefaultShadowRegistry(),
    model:"gpt-6-luna",apiKey:"test-only",transport:transportFn,...opts,
  });

function syntheticRegistration(id="energy.meter.review.v1") {
  const inputSchema=z.strictObject({id:z.literal(id),version:z.literal(1),
    purpose:z.literal("meter_read")});
  const outputSchema=z.strictObject({
    status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
    provenance:z.literal("meter_snapshot"),quality:z.literal("estimated"),
  });
  const read=vi.fn(async()=>({
    status:"partial" as const,value:{reading:7},provenance:"meter_snapshot" as const,
    quality:"estimated" as const,
  }));
  const def={
    id,version:1 as const,owner:"energy",mode:"read" as const,
    purpose:"Explain last authorized meter reading, do not treat it as invoiced usage.",
    sourceIds:["energy.meter"],allowedPurposes:["meter_read"],
    inputSchema,outputSchema,schemaContract:{
      id:id+".v1",version:1 as const,
      inputSchemaFingerprint:schemaFingerprint(inputSchema),
      outputSchemaFingerprint:schemaFingerprint(outputSchema),
    },
    requiredRole:"owner" as const,sensitivity:"normal" as const,
    budgets:{maxOperations:1,timeoutMs:500,maxResultBytes:10000,
      maxInputBytes:1000,maxRangeDays:30},
    effectPolicy:"deny" as const,requiresApproval:false as const,
    availability:"shadow" as const,read,
  };
  return {def,read};
}
describe("Universal Supervisor P2 nonproduction OpenAI shadow",()=>{
  it("publishes four real P1 readers, preserving exact versioned schema/source/role contracts",()=>{
    const manifest=createDefaultShadowRegistry().discover(scope());
    expect(manifest.map(x=>x.id).sort()).toEqual([
      "alex.pricing.review.v1","leo.money.costs.v1",
      "maya.supplies.quote_evidence.v1","olivia.availability.foundation.v1",
    ]);
    expect(manifest.every(x=>x.mode==="read"&&x.requiredRole==="owner"&&
      x.effectPolicy==="deny"&&x.availability==="shadow"&&x.sourceIds.length>0)).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/"execute"|"handler"|"read":function/);
  });
  it("interprets an unfamiliar goal through model output, then invokes real canonical Leo data",async()=>{
    const goal="Can you tell if my outgoings from October 1 to October 3 are truly covered?";
    const clauses=["my outgoings from October 1 to October 3"];
    const mock=transport({complete:true,clauses},select(clauses,[{
      capabilityId:"leo.money.costs.v1",inputJson:JSON.stringify(args),reason:null,
    }]));
    const read=vi.fn(async()=>costSummary);
    const outcome=await request(goal,mock.fn,{
      scope:scope({getBusinessCostSummary:read} as Partial<BusinessScopedCafeTools>),
    });
    expect(outcome.status).toBe("partial");
    expect(outcome.evidence[0]).toMatchObject({
      capabilityId:"leo.money.costs.v1",status:"partial",reason:null,
      result:{value:{knownTotalCents:400,missingInputs:["laborCoverage:0/3"]},
        provenance:{sourceRevision:null},quality:{missingInputs:["laborCoverage:0/3"]}},
    });
    expect(outcome.executedEffects).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(period);
    expect(outcome.usage).toMatchObject({modelCalls:2,inputTokens:84,outputTokens:24});
    expect(mock.calls.every((x:unknown)=>{const r=x as {store?:boolean;tools?:unknown};return r.store===false && !("tools" in r);})).toBe(true);
  });
  it("keeps both parts of a multi-domain goal, marking unknown inputs unavailable",async()=>{
    const goal="Review this month's labor costs and tell me whether our suppliers quoted better rates";
    const clauses=["this month's labor costs","our suppliers quoted better rates"];
    const mock=transport({complete:true,clauses},select(clauses,[
      {capabilityId:"leo.money.costs.v1",inputJson:JSON.stringify(args),reason:null},
      {capabilityId:"maya.supplies.quote_evidence.v1",inputJson:null,reason:"missing_input"},
    ]));
    const result=await request(goal,mock.fn,{
      scope:scope({getBusinessCostSummary:vi.fn(async()=>costSummary)}),
    });
    expect(result.evidence.map(x=>x.capabilityId)).toEqual([
      "leo.money.costs.v1","maya.supplies.quote_evidence.v1",
    ]);
    expect(result.evidence.map(x=>x.status)).toEqual(["partial","unavailable"]);
    expect(result.reason).toBe("some_goals_unavailable");
  });
  it("refuses an incomplete or malicious scope plan before any business reads",async()=>{
    const goal="Check labor and supplier quotes";
    const read=vi.fn(async()=>costSummary);
    for(const [audit,plan] of [
      [{complete:false,clauses:["labor"]},null],
      [{complete:true,clauses:["labor"]},null],
      [{complete:true,clauses:["labor","supplier quotes"]},
        select(["labor"],[{capabilityId:"leo.money.costs.v1",
          inputJson:JSON.stringify(args),reason:null}])],
      [{complete:true,clauses:["labor"]},
        {...select(["labor"],[{capabilityId:"leo.money.costs.v1",
          inputJson:JSON.stringify(args),reason:null}]),commit:true}],
    ] as const){
      const mock=transport(audit,plan);
      const r=await request(goal,mock.fn,{scope:scope({getBusinessCostSummary:read})});
      expect(r).toMatchObject({status:"unavailable",reason:"scope_unverified"});
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects forged business/owner/effect fields; never passes them to readers",async()=>{
    const goal="What did operating expenses contain?";
    const clauses=["operating expenses"];
    const read=vi.fn(async()=>costSummary);
    for(const extra of [
      {businessId:"other-cafe"},{ownerUserId:"other-owner"},
      {approve:true},{sql:"select * from memberships"},
      {effect:{kind:"publish_schedule"}},
    ]){
      const mock=transport({complete:true,clauses},select(clauses,[{
        capabilityId:"leo.money.costs.v1",
        inputJson:JSON.stringify({...args,...extra}),reason:null,
      }]));
      const result=await request(goal,mock.fn,{
        scope:scope({getBusinessCostSummary:read}),
      });
      expect(result.evidence[0]).toMatchObject({status:"unavailable",reason:"invalid_request"});
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("returns explicit unknown capability, and never attempts it",async()=>{
    const clauses=["reconcile cross-chain incentive rebates"];
    const mock=transport({complete:true,clauses},select(clauses,[{
      capabilityId:"unregistered.rebates.commit.v1",inputJson:"{}",reason:null,
    }]));
    const result=await request("Please reconcile cross-chain incentive rebates",mock.fn);
    expect(result.evidence[0]).toMatchObject({reason:"unknown_capability",status:"unavailable"});
    expect(result.executedEffects).toBe(0);
  });
  it("denies other tenant, disabled shadow, and absent currency rather than relabeling cents",async()=>{
    const reg=createDefaultShadowRegistry();
    const read=vi.fn(async()=>costSummary);
    const foreign={...scope({getBusinessCostSummary:read}),businessId:"other-cafe"};
    expect(reg.discover(foreign)).toEqual([]);
    expect(await reg.invoke(foreign,"leo.money.costs.v1",args))
      .toMatchObject({reason:"unauthorized"});
    const disabled={...scope({getBusinessCostSummary:read}),shadowEnabled:false};
    expect(reg.discover(disabled)).toEqual([]);
    expect(await reg.invoke(disabled,"leo.money.costs.v1",args))
      .toMatchObject({reason:"unauthorized"});
    const nonUsd={...scope({getBusinessCostSummary:read}),
      identity:{...scope().identity,currency:"EUR"}};
    expect(await reg.invoke(nonUsd,"leo.money.costs.v1",args))
      .toMatchObject({reason:"unsupported"});
    expect(read).not.toHaveBeenCalled();
  });
  it("fifth synthetic domain extends discovery and model execution without platform edits",async()=>{
    const {def,read}=syntheticRegistration();
    const registry=createP2Registry([...buildP1P2Registrations(),def]);
    expect(registry.discover(scope())).toHaveLength(5);
    const goal="Please inspect the authorized meter for yesterday's energy tracking";
    const clauses=["the authorized meter for yesterday's energy tracking"];
    const mock=transport({complete:true,clauses},select(clauses,[{
      capabilityId:def.id,inputJson:JSON.stringify({
        id:def.id,version:1,purpose:"meter_read",
      }),reason:null,
    }]));
    const result=await request(goal,mock.fn,{registry});
    expect(result.evidence[0]).toMatchObject({
      status:"partial",result:{value:{reading:7},provenance:"meter_snapshot"},
    });
    expect(read).toHaveBeenCalledOnce();
  });
  it("enforces strictly disabled modes including commit, and rejects schema drift",async()=>{
    const {def}=syntheticRegistration();
    const modes=["simulate","evaluate","propose","approve","commit"] as const;
    for(const mode of modes) {
      const inert={...def,id:"shadow."+mode+".v1",mode,
        availability:"disabled",read:undefined,
        requiresApproval:["propose","approve","commit"].includes(mode),
      };
      delete (inert as {read?:unknown}).read;
      const registry=createP2Registry([inert as P2Registration]);
      expect(registry.discover(scope())).toEqual([]);
      expect(await registry.invoke(scope(),inert.id,{}))
        .toMatchObject({reason:"mode_disabled"});
    }
    expect(()=>createP2Registry([{...def,id:"tampered.schema.v1"}])).toThrow();
    expect(()=>createP2Registry([def,def])).toThrow(/Duplicate/);
  });
  it("does not turn source-unavailable/invalid read into zero or completed effect",async()=>{
    const read=vi.fn(async()=>({...costSummary,knownTotalCents:"100"}));
    const reg=createDefaultShadowRegistry();
    const result=await reg.invoke(scope({getBusinessCostSummary:read} as unknown as Partial<BusinessScopedCafeTools>),
      "leo.money.costs.v1",args);
    expect(result).toMatchObject({status:"unavailable",reason:"invalid_result"});
    expect(JSON.stringify(result)).not.toContain("knownTotalCents");
  });
});
