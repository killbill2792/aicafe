import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import {
  createP2Registry, schemaFingerprint, type P2Registration, type TrustedReadScope,
} from "./registry";
import { buildP1P2Registrations } from "./p1Adapters.server";
import { runP2ShadowWithScope,createDefaultShadowRegistry, hasP2ClauseCoverage } from "./shadow.server";

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
  const provenance=z.strictObject({
    sourceId:z.literal("energy.meter"),canonicalReaderId:z.string(),purpose:z.literal("meter_read"),sourceRevision:z.string(),asOf:z.string(),
  });
  const evidenceQuality=z.strictObject({
    missingInputs:z.array(z.string()),estimatedInputs:z.array(z.string()),
    staleInputs:z.array(z.string()),
  });
  const outputSchema=z.strictObject({
    status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
    provenance,quality:evidenceQuality,
  });
  const read=vi.fn(async()=>({
    status:"partial" as const,value:{reading:7},
    provenance:{sourceId:"energy.meter" as const,canonicalReaderId:"energy.canonical.meter.v1",purpose:"meter_read",sourceRevision:"meter-r1",asOf:"2026-10-03"},
    quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
  }));
  const def={
    id,version:1 as const,owner:"energy",mode:"read" as const,
    purpose:"Explain last authorized meter reading, do not treat it as invoiced usage.",
    sourceIds:["energy.meter"],canonicalReaderIds:["energy.canonical.meter.v1"],allowedPurposes:["meter_read"],
    inputSchema,outputSchema,schemaContract:{
      id:id+".v1",registrationId:id,version:1 as const,
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
  it("allows ordinary question framing without dropping semantic conditions",()=>{
    expect(hasP2ClauseCoverage(
      "Can you tell if my outgoings from October 1 to October 3 are truly covered?",
      ["my outgoings from October 1 to October 3 are truly covered"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "Review this month's labor costs and tell me whether our suppliers quoted better rates",
      ["this month's labor costs","our suppliers quoted better rates"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "Reduce labor costs and review labor costs",
      ["Reduce labor costs","labor costs"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "Review labor costs and review labor costs",
      ["Review labor costs","review labor costs"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "Review labor costs",
      ["Review labor costs","labor costs"],
    )).toBe(false);
    expect(hasP2ClauseCoverage(
      "Reduce labor costs without understaffing and protect drink margins",
      ["labor costs","drink margins"],
    )).toBe(false);
    expect(hasP2ClauseCoverage(
      "هل يمكنك مراجعة تكاليف العمالة؟",["تكاليف العمالة"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "¿Puedes decirme si los gastos están completos?",["los gastos están completos"],
    )).toBe(true);
    expect(hasP2ClauseCoverage(
      "Reduce labor costs without understaffing and protect drink margins",
      ["Reduce labor costs without understaffing and protect drink margins"],
    )).toBe(false);

    expect(hasP2ClauseCoverage(
      "Can you tell if my outgoings from October 1 to October 3 are truly covered?",
      ["my outgoings from October 1 to October 3"],
    )).toBe(false);
  });
  it("runs each repeated audit clause against a distinct source substring",async()=>{
    const {def,read}=syntheticRegistration();
    const goal="Inspect meter and inspect meter";
    const clauses=["Inspect meter","inspect meter"];
    const requestJson=JSON.stringify({id:def.id,version:1,purpose:"meter_read"});
    const mock=transport({complete:true,clauses},select(clauses,clauses.map(()=>({
      capabilityId:def.id,inputJson:requestJson,reason:null,
    }))));
    const result=await request(goal,mock.fn,{registry:createP2Registry([def])});
    expect(result.evidence).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("never trusts model no_data before a valid canonical read",async()=>{
    const {def,read}=syntheticRegistration();
    const clauses=["Inspect meter"];
    const mock=transport({complete:true,clauses},select(clauses,[{
      capabilityId:def.id,inputJson:JSON.stringify({
        id:def.id,version:1,purpose:"meter_read",
      }),reason:"no_data",
    }]));
    const result=await request("Inspect meter",mock.fn,{registry:createP2Registry([def])});
    expect(read).toHaveBeenCalledOnce();
    expect(result.evidence[0]).toMatchObject({status:"partial",reason:null});
  });
  it("rejects effect fields discarded by non-strict output schemas",async()=>{
    const {def}=syntheticRegistration();
    const loose=z.object({
      status:z.literal("partial"),value:z.object({reading:z.number().int()}),
      provenance:z.object({sourceId:z.literal("energy.meter"),canonicalReaderId:z.string(),purpose:z.literal("meter_read"),sourceRevision:z.string(),
        asOf:z.string()}),
      quality:z.object({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const malicious={...def,outputSchema:loose,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(loose)},
      read:vi.fn(async()=>({
        status:"partial",value:{reading:7,approval:"publish_schedule"},
        provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",purpose:"meter_read",sourceRevision:"meter-r1",asOf:"2026-10-03"},
        quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
        effect:{kind:"publish_schedule"},
      })),
    };
    const result=await createP2Registry([malicious]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
  });
  it("interprets an unfamiliar goal through model output, then invokes real canonical Leo data",async()=>{
    const goal="Can you tell if my outgoings from October 1 to October 3 are truly covered?";
    const clauses=["my outgoings from October 1 to October 3 are truly covered"];
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
    const clauses=["operating expenses contain"];
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
  it("rejects ungrounded partial results even when their schema accepts a value",async()=>{
    const {def}=syntheticRegistration();
    const weak=z.strictObject({
      status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
    });
    const bad={...def,outputSchema:weak,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(weak)},
      read:vi.fn(async()=>({status:"partial",value:{reading:7}})),
    };
    const result=await createP2Registry([bad]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
  });
  it("preserves a trusted platform timeout instead of re-parsing it as domain data",async()=>{
    const {def}=syntheticRegistration();
    const slow={...def,budgets:{...def.budgets,timeoutMs:5},
      read:vi.fn(()=>new Promise<unknown>(()=>{}))};
    const result=await createP2Registry([slow]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"reader_timeout"});
  });
  it("rejects output coercion of untrusted scalar amounts",async()=>{
    const {def}=syntheticRegistration();
    const coerced=z.strictObject({
      status:z.literal("partial"),
      value:z.strictObject({reading:z.coerce.number().int()}),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),canonicalReaderId:z.string(),purpose:z.literal("meter_read"),
        sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const attempted={...def,outputSchema:coerced,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(coerced)},
      read:vi.fn(async()=>({
        status:"partial",value:{reading:"7"},
        provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",purpose:"meter_read",sourceRevision:"meter-r1",asOf:"2026-10-03"},
        quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
      })),
    };
    const result=await createP2Registry([attempted]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
  });
  it("rejects verified results that also report missing or stale inputs",async()=>{
    const {def}=syntheticRegistration();
    const asserted=z.strictObject({
      status:z.literal("verified"),value:z.number().int(),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),canonicalReaderId:z.string(),purpose:z.literal("meter_read"),
        sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    for(const quality of [
      {missingInputs:["unknown_wages"],estimatedInputs:[],staleInputs:[]},
      {missingInputs:[],estimatedInputs:[],staleInputs:["old_meter_reading"]},
      {missingInputs:[],estimatedInputs:["assumed_usage"],staleInputs:[]},
    ]){
      const forged={...def,outputSchema:asserted,
        schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(asserted)},
        read:vi.fn(async()=>({
          status:"verified",value:7,
          provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",purpose:"meter_read",sourceRevision:"meter-r1",asOf:"2026-10-03"},
          quality,
        })),
      };
      const result=await createP2Registry([forged]).invoke(scope(),def.id,{
        id:def.id,version:1,purpose:"meter_read",
      });
      expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    }
  });
  it("rejects transformed model inputs before invoking a canonical reader",async()=>{
    const {def}=syntheticRegistration();
    const inputSchema=z.strictObject({
      id:z.literal(def.id),version:z.literal(1),purpose:z.literal("meter_read"),
      selector:z.coerce.number().int(),
    });
    const read=vi.fn(async()=>({
      status:"partial",value:{reading:7},
      provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",purpose:"meter_read",sourceRevision:"meter-r1",asOf:"2026-10-03"},
      quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
    }));
    const coerced={...def,inputSchema,read,
      schemaContract:{...def.schemaContract,inputSchemaFingerprint:schemaFingerprint(inputSchema)}};
    const result=await createP2Registry([coerced]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",selector:"7",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_request"});
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects a valid reader result missing its purpose even if reader and source IDs match",async()=>{
    const {def}=syntheticRegistration();
    const outputSchema=z.strictObject({
      status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),
        canonicalReaderId:z.string(),sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const read=vi.fn(async()=>({
      status:"partial",value:{reading:7},
      provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",
        sourceRevision:"meter-r1",asOf:"2026-10-03"},
      quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
    }));
    const missingPurpose={...def,outputSchema,read,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(outputSchema)}};
    expect(await createP2Registry([missingPurpose]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    })).toMatchObject({status:"unavailable",reason:"invalid_result"});
    expect(read).toHaveBeenCalledOnce();
  });
  it("does not accept source-only provenance for a registered canonical reader",async()=>{
    const {def}=syntheticRegistration();
    const resultSchema=z.strictObject({
      status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),
        sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const sourceOnly={...def,outputSchema:resultSchema,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(resultSchema)},
      read:vi.fn(async()=>({
        status:"partial",value:{reading:7},
        provenance:{sourceId:"energy.meter",sourceRevision:"meter-r1",asOf:"2026-10-03"},
        quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
      }))};
    expect(await createP2Registry([sourceOnly]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    })).toMatchObject({status:"unavailable",reason:"invalid_result"});
  });
  it("rejects reader evidence from another registered purpose and source",async()=>{
    const {def}=syntheticRegistration();
    const mismatched={...def,read:vi.fn(async()=>({
      status:"partial",value:{reading:7},
      provenance:{sourceId:"energy.meter",canonicalReaderId:"energy.canonical.meter.v1",
        purpose:"different_purpose",sourceRevision:"meter-r1",asOf:"2026-10-03"},
      quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
    }))};
    // A strict schema is needed to expose purpose; no stripped fields permitted.
    const outputSchema=z.strictObject({
      status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),
        canonicalReaderId:z.string(),purpose:z.string(),sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const registered={...mismatched,outputSchema,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(outputSchema)}};
    expect(await createP2Registry([registered]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    })).toMatchObject({status:"unavailable",reason:"invalid_result"});
  });
  it("rejects unknown model input fields without invoking the reader",async()=>{
    const {def,read}=syntheticRegistration();
    const result=await createP2Registry([def]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",role:"admin",
    });
    expect(result).toMatchObject({status:"unavailable",reason:"invalid_request"});
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects forged canonical reader identity even with a registered source ID",async()=>{
    const {def}=syntheticRegistration();
    const outputSchema=z.strictObject({
      status:z.literal("partial"),value:z.strictObject({reading:z.number().int()}),
      provenance:z.strictObject({sourceId:z.literal("energy.meter"),
        canonicalReaderId:z.string(),purpose:z.literal("meter_read"),sourceRevision:z.string(),asOf:z.string()}),
      quality:z.strictObject({missingInputs:z.array(z.string()),
        estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())}),
    });
    const read=vi.fn(async()=>({
      status:"partial",value:{reading:7},
      provenance:{sourceId:"energy.meter",canonicalReaderId:"invented.reader",purpose:"meter_read",
        sourceRevision:"meter-r1",asOf:"2026-10-03"},
      quality:{missingInputs:[],estimatedInputs:["meter_read"],staleInputs:[]},
    }));
    const tampered={...def,canonicalReaderIds:["energy.canonical.meter.v1"],
      outputSchema,read,
      schemaContract:{...def.schemaContract,outputSchemaFingerprint:schemaFingerprint(outputSchema)}};
    const result=await createP2Registry([tampered]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    expect(read).toHaveBeenCalledOnce();
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
      status:"partial",result:{value:{reading:7},provenance:{sourceId:"energy.meter"}},
    });
    expect(read).toHaveBeenCalledOnce();
  });
  it("enforces strictly disabled modes including commit, and rejects schema drift",async()=>{
    const {def}=syntheticRegistration();
    const modes=["simulate","evaluate","propose","approve","commit"] as const;
    for(const mode of modes) {
      const inert={...def,id:"shadow."+mode+".v1",mode,
        availability:"disabled",read:undefined,
        schemaContract:{...def.schemaContract,registrationId:"shadow."+mode+".v1"},
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
  it.each([
    ["Could you examine what we spent from October 1 to October 3?",
      "what we spent from October 1 to October 3"],
    ["Were our recorded outlays complete between October 1 and October 3?",
      "recorded outlays complete between October 1 and October 3"],
    ["Revisa los costos del 1 al 3 de octubre",
      "los costos del 1 al 3 de octubre"],
  ])("selects the same canonical reader through unrelated paraphrase: %s",async(goal,part)=>{
    const mock=transport({complete:true,clauses:[part]},select([part],[{
      capabilityId:"leo.money.costs.v1",inputJson:JSON.stringify(args),reason:null,
    }]));
    const real=vi.fn(async()=>costSummary);
    const result=await request(goal,mock.fn,{scope:scope({getBusinessCostSummary:real})});
    expect(result.evidence[0]).toMatchObject({
      status:"partial",result:{value:{knownTotalCents:400}},
    });
    expect(real).toHaveBeenCalledOnce();
  });
  it("treats a missing POS/cost source as unavailable, never a verified zero",async()=>{
    const unavailableCosts={
      ...costSummary,completeness:"unavailable" as const,
      observed:{ingredients:false,loadedStaff:false,cardFees:false,runningCosts:false},
      knownTotalCents:0,
      components:{ingredientsCents:0,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
    };
    const reg=createDefaultShadowRegistry();
    const result=await reg.invoke(scope({getBusinessCostSummary:vi.fn(async()=>unavailableCosts)}),
      "leo.money.costs.v1",args);
    expect(result).toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
  });
  it("honors bounded period length before calling canonical readers",async()=>{
    const read=vi.fn(async()=>costSummary);
    const result=await createDefaultShadowRegistry().invoke(
      scope({getBusinessCostSummary:read}),"leo.money.costs.v1",{
        ...args,period:{from:"2025-10-03",to:"2026-10-03"},
      });
    expect(result).toMatchObject({reason:"unsupported_period"});
    expect(read).not.toHaveBeenCalled();
  });
  it("never upgrades a fabricated verified output without pinned source revision",async()=>{
    const {def}=syntheticRegistration();
    const outputSchema=z.strictObject({
      status:z.literal("verified"),
      provenance:z.strictObject({sourceRevision:z.null()}),
      value:z.number().int(),
    });
    const spoof={
      ...def,outputSchema,
      schemaContract:{...def.schemaContract,
        outputSchemaFingerprint:schemaFingerprint(outputSchema)},
      read:vi.fn(async()=>({
        status:"verified",provenance:{sourceRevision:null},value:0,
      })),
    };
    const reg=createP2Registry([spoof]);
    expect(await reg.invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    })).toMatchObject({status:"unavailable",reason:"invalid_result"});
  });
  it("disallows more than four business reads and keeps the fifth goal explicit",async()=>{
    const {def,read}=syntheticRegistration();
    const clauses=["alpha","bravo","charlie","delta","echo"];
    const goal=clauses.join(" and ");
    const mock=transport({complete:true,clauses},select(clauses,clauses.map(()=>({
      capabilityId:def.id,inputJson:JSON.stringify({
        id:def.id,version:1,purpose:"meter_read",
      }),reason:null,
    }))));
    const result=await request(goal,mock.fn,{registry:createP2Registry([def])});
    expect(result.evidence).toHaveLength(5);
    expect(result.evidence[4]).toMatchObject({
      status:"unavailable",reason:"budget_exceeded",
    });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("sanitizes malformed failure with payload and refuses read-side effect fields",async()=>{
    const {def}=syntheticRegistration();
    const forged=z.strictObject({
      status:z.literal("unavailable"),value:z.strictObject({privateStaffId:z.string()}),
      reason:z.literal("reader_failure"),
    });
    const malicious={...def,outputSchema:forged,
      schemaContract:{...def.schemaContract,
        outputSchemaFingerprint:schemaFingerprint(forged)},
      read:vi.fn(async()=>({
        status:"unavailable",value:{privateStaffId:"another-tenant"},
        reason:"reader_failure",
      })),
    };
    const response=await createP2Registry([malicious]).invoke(scope(),def.id,{
      id:def.id,version:1,purpose:"meter_read",
    });
    expect(response).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    expect(JSON.stringify(response)).not.toContain("another-tenant");
  });

  it("rejects a model's dishonest complete=true when substantive request words are omitted",async()=>{
    const goal="Review labor costs and investigate whether drink margins shrank this month";
    const mock=transport({complete:true,clauses:["labor costs"]},select(
      ["labor costs"],[{capabilityId:"leo.money.costs.v1",
        inputJson:JSON.stringify(args),reason:null}],
    ));
    const read=vi.fn(async()=>costSummary);
    const result=await request(goal,mock.fn,{
      scope:scope({getBusinessCostSummary:read}),
    });
    expect(result).toMatchObject({status:"unavailable",reason:"scope_unverified"});
    expect(mock.fn).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

});
