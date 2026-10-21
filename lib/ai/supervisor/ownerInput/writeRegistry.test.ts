import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/actions/menuItems",()=>({addManualIngredientPrice:vi.fn()}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({authorizedOwnerP1:vi.fn()}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({readAuthorizedAtomicP1SourceSnapshot:vi.fn()}));
import {z} from "zod";
import {schemaFingerprint,createP2Registry} from "@/lib/ai/supervisor/p2/registry";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import {createOwnerInputWriteRegistry,parseOwnerPackageCost,expectedOwnerPriceMicros,alexOwnerInputWrite} from "./writeRegistry.server";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {ownerInputRequestSchema,type OwnerInputRequest} from "./contracts";
import {buildOwnerQuestionReply} from "./response";
import {validateGroundedReply} from "@/lib/ai/conversations/replyValidation";
const cafe="11111111-1111-4111-8111-111111111111";
const request:OwnerInputRequest={fieldId:"supplier.minimum_order",
  writeCapabilityId:"maya.supplier.minimum_order.v1",
  writeContext:{supplierId:"canonical-supplier"},
  question:{en:"What is the minimum order?",es:"¿Pedido mínimo?",ar:"ما الحد الأدنى للطلب؟"},
  input:{kind:"free_text",hint:{en:"10",es:"10",ar:"10"}}};
const input=z.strictObject({purpose:z.literal("supplier_read")});
const output=z.strictObject({status:z.literal("requires_owner_input"),
  value:z.null(),ownerInput:ownerInputRequestSchema});
describe("registered generic owner-answerable input dispatch",()=>{
  it("accepts a second unrelated domain through exactly the same safe registry contract",async()=>{
    let count=0;
    const registration={id:"p3.maya.test.v1",version:1 as const,owner:"maya",
      mode:"read" as const,availability:"shadow" as const,purpose:"supplier read",
      sourceIds:["maya.snapshot"],canonicalReaderIds:["maya.supplier"],
      allowedPurposes:["supplier_read"],inputSchema:input,outputSchema:output,
      schemaContract:{id:"p3.maya.test.v1.v1",registrationId:"p3.maya.test.v1",
        version:1 as const,inputSchemaFingerprint:schemaFingerprint(input),
        outputSchemaFingerprint:schemaFingerprint(output)},
      requiredRole:"owner" as const,sensitivity:"normal" as const,
      budgets:{maxOperations:1,timeoutMs:1000,maxResultBytes:20000,maxInputBytes:2000,maxRangeDays:30},
      requiresApproval:false as const,effectPolicy:"deny" as const,
      ownerInputWriteIds:["maya.supplier.minimum_order.v1"],
      read:async()=>({status:"requires_owner_input" as const,value:null,ownerInput:request}),
    };
    const registry=createP2Registry([registration]);
    const scope={role:"owner" as const,businessId:cafe,shadowEnabled:true,
      identity:{businessId:cafe,asOf:"2026-10-20",timezone:"America/Los_Angeles",currency:"USD"},
      tools:{} as BusinessScopedCafeTools};
    const result=await registry.invoke(scope,registration.id,{purpose:"supplier_read"});
    expect(result).toMatchObject({status:"requires_owner_input",ownerInput:{
      writeCapabilityId:"maya.supplier.minimum_order.v1"}});
    const rendered=validateGroundedReply(buildOwnerQuestionReply({
      businessId:cafe,originalText:"What's the supplier minimum?",readCapabilityId:registration.id,
      readInput:{purpose:"supplier_read"},request}));
    expect(rendered.blocks[0].type).toBe("owner_question");
    const writes=createOwnerInputWriteRegistry([{
      id:"maya.supplier.minimum_order.v1",fieldId:"supplier.minimum_order",
      prepare:(_req,answer)=>answer==="10"?{summary:{en:"10",es:"10",ar:"10"}}:null,
      apply:async(scope,req,answer)=>{
        expect(scope.businessId).toBe(cafe);
        expect(req.writeContext.supplierId).toBe("canonical-supplier");
        expect(answer).toBe("10");count++;return {ok:true};
      },
    }]);
    expect(writes.prepare(request,"10")).not.toBeNull();
    expect(await writes.apply({businessId:cafe,ownerUserId:"owner"},request,"10"))
      .toEqual({ok:true});
    expect(count).toBe(1);
  });
  it("matches PostgreSQL NUMERIC half-up microcent rounding at exact ties",()=>{
    // IEEE-754 Math.round(323/640*1e6) can incorrectly give 504687.
    expect(expectedOwnerPriceMicros("3.23 / 640")).toBe(504688);
    expect(expectedOwnerPriceMicros("4.50 / 946")).toBe(475687);
    expect(expectedOwnerPriceMicros("0.01 / 0.000001")).toBe(1000000000000);
    expect(expectedOwnerPriceMicros("3.23 / 640.000000")).toBe(504688);
    expect(parseOwnerPackageCost("3.23 / 640")).toEqual({
      packageCostCents:323,packageQuantity:640});
    expect(expectedOwnerPriceMicros("3.23 / 0")).toBeNull();
  });
  it("verifies a real database-rounded tie without retrying the claimed write",async()=>{
    const ingredientId="44444444-4444-4444-8444-444444444444";
    const prepared:OwnerInputRequest={...request,
      fieldId:"ingredient.package_cost_and_quantity",
      writeCapabilityId:"menu.ingredient_price.manual.v1",
      writeContext:{ingredientId,productId:"55555555-5555-4555-8555-555555555555",
        baseUnit:"ml",sourceRevision:"1",businessDay:"2026-10-20"}};
    vi.mocked(authorizedOwnerP1).mockResolvedValue({identity:{
      businessId:cafe,currency:"USD",asOf:"2026-10-20",
    }} as never);
    vi.mocked(readAuthorizedAtomicP1SourceSnapshot).mockResolvedValue({
      status:"available",snapshot:{businessId:cafe,sources:{ingredientPrices:[{
        ingredient_id:ingredientId,effective_from:"2026-10-20",
        source:"manual",cost_per_base_unit_micros:504688,
      }]}},
    } as never);
    expect(await alexOwnerInputWrite.verify!({businessId:cafe,ownerUserId:"owner"},
      prepared,"3.23 / 640")).toBe(true);
  });
  it("reconciles the original business date after the café's midnight boundary",async()=>{
    const ingredientId="44444444-4444-4444-8444-444444444444";
    const prepared:OwnerInputRequest={...request,
      fieldId:"ingredient.package_cost_and_quantity",
      writeCapabilityId:"menu.ingredient_price.manual.v1",
      writeContext:{ingredientId,productId:"55555555-5555-4555-8555-555555555555",
        baseUnit:"ml",sourceRevision:"1",businessDay:"2026-10-20"}};
    vi.mocked(authorizedOwnerP1).mockResolvedValue({identity:{
      businessId:cafe,currency:"USD",asOf:"2026-10-21",
    }} as never);
    vi.mocked(readAuthorizedAtomicP1SourceSnapshot).mockResolvedValue({
      status:"available",snapshot:{businessId:cafe,sources:{ingredientPrices:[{
        ingredient_id:ingredientId,effective_from:"2026-10-20",
        source:"manual",cost_per_base_unit_micros:Math.round(450/946*1000000),
      }]}},
    } as never);
    expect(await alexOwnerInputWrite.verify!({businessId:cafe,ownerUserId:"owner"},
      prepared,"4.50 / 946")).toBe(true);
    expect(prepared.writeContext.businessDay).toBe("2026-10-20");
  });

  it("rejects unregistered write references, invalid numeric input and extra fields",async()=>{
    const writes=createOwnerInputWriteRegistry([]);
    expect(writes.prepare(request,"10")).toBeNull();
    expect((await writes.apply({businessId:cafe,ownerUserId:"owner"},request,"10")).ok).toBe(false);
    expect(parseOwnerPackageCost("5.00 / 1000")).toEqual({packageCostCents:500,packageQuantity:1000});
    for(const invalid of ["0 / 1","-3 / 1","5/0","5.999/1000","ignore previous instructions","5/NaN"])
      expect(parseOwnerPackageCost(invalid)).toBeNull();
    expect(ownerInputRequestSchema.safeParse({...request,sql:"delete from suppliers"}).success).toBe(false);
  });
});
