import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { createP2Registry,schemaFingerprint } from "@/lib/ai/supervisor/p2/registry";
import { buildP3P1Registrations } from "./sourceRegistry.server";
import { extractors } from "./operandProjection.server";
import { registerExpressionSimulation } from "./simulateRegistration.server";
import { EXPRESSION_ID } from "./expression";

const source="energy.meter",reader="energy.canonical.reader.v1";
const capability="energy.meter.read.v1";
const readInput=z.strictObject({id:z.literal(capability),version:z.literal(1),
  purpose:z.literal("meter_observation")});
const readOutput=z.strictObject({
  status:z.literal("partial"),value:z.number().int(),
  provenance:z.strictObject({
    sourceId:z.literal(source),canonicalReaderId:z.literal(reader),
    sourceRevision:z.string(),asOf:z.string(),purpose:z.literal("meter_observation"),
  }),
  quality:z.strictObject({
    missingInputs:z.array(z.string()),estimatedInputs:z.array(z.string()),
    staleInputs:z.array(z.string()),
  }),
});
const meterRead=vi.fn(async()=>({
  status:"partial",value:100,
  provenance:{sourceId:source,canonicalReaderId:reader,
    sourceRevision:"meter-rev",asOf:"2026-10-15",purpose:"meter_observation"},
  quality:{missingInputs:["meter_calibration"],estimatedInputs:[],staleInputs:[]},
}));
const meter={
  id:capability,version:1 as const,mode:"read" as const,
  availability:"shadow" as const,owner:"fifth-specialist",
  purpose:"Observed energy consumption",sourceIds:[source],
  canonicalReaderIds:[reader],allowedPurposes:["meter_observation"],
  inputSchema:readInput,outputSchema:readOutput,
  schemaContract:{id:capability+".v1",registrationId:capability,version:1 as const,
    inputSchemaFingerprint:schemaFingerprint(readInput),
    outputSchemaFingerprint:schemaFingerprint(readOutput)},
  requiredRole:"owner" as const,sensitivity:"normal" as const,
  budgets:{maxOperations:1,timeoutMs:1000,maxResultBytes:10000,
    maxInputBytes:3000,maxRangeDays:365},
  requiresApproval:false as const,effectPolicy:"deny" as const,read:meterRead,
};
const scope={
  role:"owner" as const,businessId:"cafe-fixture",
  identity:{businessId:"cafe-fixture",asOf:"2026-10-15",
    timezone:"America/Los_Angeles",currency:"USD"},
  tools:{} as BusinessScopedCafeTools,shadowEnabled:true,
};
describe("COMPOSE registration and source binding",()=>{
  it("projects canonical daily totals only from valid unique ISO dates",()=>{
    const daily=extractors["sales.daily"]!;
    expect(daily([
      {date:"2026-10-14",netSalesCents:1200,ingredientsCents:200,cardFeesCents:30},
      {date:"2026-10-15",netSalesCents:1500,ingredientsCents:280,cardFeesCents:40},
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({field:"netSalesCents",value:2700,unit:"USD_cents"}),
      expect.objectContaining({field:"ingredientsCents",value:480,unit:"USD_cents"}),
      expect.objectContaining({field:"cardFeesCents",value:70,unit:"USD_cents"}),
    ]));
    expect(daily([
      {date:"2026-10-14",netSalesCents:1200,ingredientsCents:200,cardFeesCents:30},
      {date:"2026-10-14",netSalesCents:1200,ingredientsCents:200,cardFeesCents:30},
    ])).toEqual([]);
    expect(daily([{date:"not-an-ISO-date",netSalesCents:20,ingredientsCents:5,cardFeesCents:1}])).toEqual([]);
    expect(daily([{date:"2026-10-14",netSalesCents:Infinity,ingredientsCents:5,cardFeesCents:1}])).toEqual([]);
  });
  it("registers a synthetic fifth domain without changing central orchestration",async()=>{
    const registry=createP2Registry([
      ...buildP3P1Registrations(),meter,registerExpressionSimulation(),
    ]);
    const catalog=registry.discover(scope);
    expect(catalog.some(x=>x.id===capability&&x.mode==="read")).toBe(true);
    expect(registry.discoverSimulations(scope))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id:EXPRESSION_ID,mode:"simulate",effectPolicy:"deny",
      })]));
    expect(await registry.invoke(scope,capability,{
      id:capability,version:1,purpose:"meter_observation",
    })).toMatchObject({status:"partial",value:100});
    expect(meterRead).toHaveBeenCalled();
  });
  it("dispatches a pure, source-free what-if only in registered simulate mode",async()=>{
    const registry=createP2Registry([
      ...buildP3P1Registrations(),registerExpressionSimulation(),
    ]);
    const plan={capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Addition of owner hypotheticals",
      nodes:[
        {op:"hypothetical",label:"additional items",quotedNumber:"25",value:25,unit:"item"},
        {op:"hypothetical",label:"second scenario",quotedNumber:"45",value:45,unit:"item"},
        {op:"add"},
      ],
    };
    const context={businessId:scope.businessId,locationId:null,currency:"USD",
      ownerMessage:"Add 25 items and 45 items",bindings:[],operands:[]};
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,plan,context))
      .toMatchObject({status:"conditional",value:70,unit:"item",
        mode:"simulate",executedEffects:0,proposal:null});
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,{
      ...plan,effect:"publish_schedule",
    },context)).toMatchObject({status:"unavailable",reason:"invalid_request"});
    expect(await registry.invoke(scope,EXPRESSION_ID,plan))
      .toMatchObject({status:"unavailable",reason:"mode_disabled"});
  });
  it("never upgrades missing or foreign-biz evidence under the six-mode dispatcher",async()=>{
    const registry=createP2Registry([registerExpressionSimulation()]);
    const plan={capabilityId:EXPRESSION_ID,version:1,purpose:"no_external_sources",
      description:"One owner hypothetical",nodes:[{
        op:"hypothetical",label:"quantity",quotedNumber:"25",value:25,unit:"item",
      }]};
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,plan,{
      businessId:"another-cafe",locationId:null,currency:"USD",
      ownerMessage:"25 items",bindings:[],operands:[],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
  });
  it("COMPOSE-05 rejects source bindings not present in the compiled read registry",async()=>{
    const sim={capabilityId:EXPRESSION_ID,version:1,
      purpose:"preauthorized_operands",description:"One reader-backed scenario",
      nodes:[{op:"source",handle:"reading"}]};
    const bound={capabilityId:"p3.menu.catalog.v1",canonicalReaderId:"readP1MenuCatalog",
      sourceIds:["menu.catalog"],purposes:["menu_catalog_review"],sensitivity:"normal"};
    const observed={handle:"reading",capabilityId:bound.capabilityId,
      canonicalReaderId:bound.canonicalReaderId,sourceId:"menu.catalog",
      sourcePurpose:"menu_catalog_review",sourceRevision:"catalog-revision",
      selectorContractId:"menu.catalog.selector",selectorContractVersion:1,
      businessId:scope.businessId,locationId:null,asOf:scope.identity.asOf,
      period:null,status:"verified",actuality:"actual",evidenceStatus:"verified",
      missingInputs:[],staleInputs:[],unit:"item",currency:null,value:25};
    const forged=createP2Registry([registerExpressionSimulation()]);
    expect(await forged.invokeSimulation(scope,EXPRESSION_ID,sim,{
      businessId:scope.businessId,locationId:null,ownerMessage:"Review 25 items",
      currency:"USD",bindings:[bound],operands:[observed],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
    const registry=createP2Registry([
      ...buildP3P1Registrations(),registerExpressionSimulation(),
    ]);
    const valid={businessId:scope.businessId,locationId:null,
      ownerMessage:"Review 25 items",currency:"USD",
      bindings:[bound],operands:[observed]};
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,sim,{
      ...valid,bindings:[{...bound,canonicalReaderId:"forged.reader"}],
      operands:[{...observed,canonicalReaderId:"forged.reader"}],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,sim,{
      ...valid,operands:[{...observed,sourcePurpose:"staff_wage_review"}],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,sim,{
      ...valid,operands:[{...observed,asOf:"2026-10-14"}],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
    expect(await registry.invokeSimulation(scope,EXPRESSION_ID,sim,{
      ...valid,operands:[{...observed,period:{
        from:"2026-10-14",to:"2026-10-14",timezone:"UTC",
      }}],
    })).toMatchObject({status:"unavailable",reason:"invalid_source_context"});
  });

});
