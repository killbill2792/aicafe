import { z } from "zod";
import { alexSimulateInputSchema, type AlexSimulateInput } from "./alexPricing";
import type { AtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";

const name=z.string().min(1).max(240);
const amount=z.number().finite().positive().max(1_000_000);
const cents=z.number().int().safe().min(0).max(100_000_000);
const quantity=z.strictObject({value:amount,unit:z.enum(["g","ml","fl_oz","each"])});
export const namedAlexChangeSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("ingredient_multiplier"),ingredientName:name,
    multiplierBasisPoints:z.number().int().min(0).max(100000)}),
  z.strictObject({kind:z.literal("ingredient_unit_cost"),ingredientName:name,costPerBaseUnitMicros:cents}),
  z.strictObject({kind:z.literal("supplier_package"),ingredientName:name,packageCostCents:cents,
    packageCount:z.number().int().min(1).max(1000000),packageUnit:z.enum(["gal","fl_oz","ml","g","each"])}),
  z.strictObject({kind:z.literal("replace_ingredient"),fromIngredientName:name,toIngredientName:name,
    quantity:quantity.optional()}),
  z.strictObject({kind:z.literal("set_quantity"),ingredientName:name,quantity}),
]);
/** Expose every existing pure Alex scenario, with owner-usable exact names as
 * an alternative to UUIDs. Canonical calculation schemas and math stay intact. */
export const alexNamedSimulateInputSchema=z.strictObject({
  ...alexSimulateInputSchema.shape,
  changes:z.array(z.union([alexSimulateInputSchema.shape.changes.element,namedAlexChangeSchema])).max(20),
}).refine(x=>x.targetCostRatioBps===undefined || x.targetIngredientMarginBps===undefined,
  {message:"Select exactly one target ratio or ingredient-only margin"});
export type AlexNamedSimulateInput=z.infer<typeof alexNamedSimulateInputSchema>;
const normalize=(v:string)=>v.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();
export function resolveAlexIngredientNames(snapshot:AtomicP1SourceSnapshot,input:AlexNamedSimulateInput):
  {ok:true;input:AlexSimulateInput}|{ok:false;reason:string}{
  // Name resolution and simulation use ONE canonical snapshot. A second roster
  // lookup would reintroduce source races or permit truncated uniqueness claims.
  if(input.changes.some(c=>"ingredientName" in c||"fromIngredientName" in c) && snapshot.truncated.ingredients)
    return {ok:false,reason:"ingredient_catalog_truncated"};
  const find=(label:string)=>snapshot.sources.ingredients.filter(i=>normalize(i.name)===normalize(label));
  const changes:AlexSimulateInput["changes"]=[];
  for(const change of input.changes){
    if("fromIngredientName" in change){
      const from=find(change.fromIngredientName),to=find(change.toIngredientName);
      if(from.length!==1||to.length!==1)return {ok:false,reason:
        from.length>1||to.length>1?"ambiguous_ingredient_name":"ingredient_not_found"};
      changes.push({kind:change.kind,fromIngredientId:from[0].id,toIngredientId:to[0].id,
        ...(change.quantity?{quantity:change.quantity}:{})});
    }else if("ingredientName" in change){
      const found=find(change.ingredientName);
      if(found.length!==1)return {ok:false,reason:found.length>1?"ambiguous_ingredient_name":"ingredient_not_found"};
      switch(change.kind){
        case "ingredient_multiplier": changes.push({kind:change.kind,ingredientId:found[0].id,
          multiplierBasisPoints:change.multiplierBasisPoints}); break;
        case "ingredient_unit_cost": changes.push({kind:change.kind,ingredientId:found[0].id,
          costPerBaseUnitMicros:change.costPerBaseUnitMicros}); break;
        case "supplier_package": changes.push({kind:change.kind,ingredientId:found[0].id,
          packageCostCents:change.packageCostCents,packageCount:change.packageCount,packageUnit:change.packageUnit}); break;
        case "set_quantity": changes.push({kind:change.kind,ingredientId:found[0].id,quantity:change.quantity}); break;
      }
    }else changes.push(change);
  }
  return {ok:true,input:{...input,changes}};
}
