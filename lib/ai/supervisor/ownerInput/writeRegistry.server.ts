import "server-only";
import {z} from "zod";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {addManualIngredientPrice} from "@/lib/actions/menuItems";
import {ownerInputRequestSchema,type OwnerInputRequest} from "./contracts";

export type OwnerInputWriteScope={businessId:string;ownerUserId:string};
export type PreparedInput={summary:Record<"en"|"es"|"ar",string>};
export type OwnerInputWriteRegistration={
  id:string;fieldId:string;
  prepare:(request:OwnerInputRequest,answer:string)=>PreparedInput|null;
  apply:(scope:OwnerInputWriteScope,request:OwnerInputRequest,answer:string)=>
    Promise<{ok:true}|{ok:false;reason:string}>;
  verify?:(scope:OwnerInputWriteScope,request:OwnerInputRequest,answer:string)=>Promise<boolean>;
};
/** The registry is compiled from domain-owned reviewed handlers; the model may only select an ID. */
export function createOwnerInputWriteRegistry(definitions:readonly OwnerInputWriteRegistration[]){
  const byId=new Map<string,OwnerInputWriteRegistration>();
  for(const d of definitions){
    if(byId.has(d.id))throw new Error("Duplicate owner-input write capability");
    byId.set(d.id,d);
  }
  function selected(raw:unknown){
    const request=ownerInputRequestSchema.safeParse(raw);
    if(!request.success)return null;
    const entry=byId.get(request.data.writeCapabilityId);
    return entry&&entry.fieldId===request.data.fieldId?{entry,request:request.data}:null;
  }
  return {
    ids:()=>[...byId.keys()],
    prepare:(raw:unknown,answer:string):PreparedInput|null=>{
      const match=selected(raw);
      return match?match.entry.prepare(match.request,answer):null;
    },
    async verify(scope:OwnerInputWriteScope,raw:unknown,answer:string){
      const match=selected(raw);
      return !!match&&!!match.entry.verify&&
        !!match.entry.prepare(match.request,answer)&&
        await match.entry.verify(scope,match.request,answer);
    },
    async apply(scope:OwnerInputWriteScope,raw:unknown,answer:string){
      const match=selected(raw);
      if(!match||!match.entry.prepare(match.request,answer))
        return {ok:false as const,reason:"invalid_owner_input"};
      return match.entry.apply(scope,match.request,answer);
    },
  };
}
/** The one permitted input grammar is a USD package cost followed by a positive
 * quantity in the ALREADY-KNOWN canonical ingredient base unit. No freeform AI arithmetic. */
/** PostgreSQL NUMERIC round() on positive values is exact, ties away from zero.
 * The owner grammar permits at most six quantity decimals; preserve those
 * decimal digits instead of introducing IEEE-754 half-cent drift. */
function ownerPackagePriceParts(input:string){
  const parsed=z.string().trim().regex(/^\\d{1,6}(?:\\.\\d{1,2})?\\s*\\/\\s*\\d{1,7}(?:\\.\\d{1,6})?$/).safeParse(input);
  if(!parsed.success)return null;
  const [price,quantity]=parsed.data.split("/").map(s=>s.trim());
  const [whole,fraction=""]=price.split(".");
  const cents=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  const [quantityWhole,quantityFraction=""]=quantity.split(".");
  const scaledQuantity=BigInt(quantityWhole)*1_000_000n+
    BigInt(quantityFraction.padEnd(6,"0")||"0");
  if(!Number.isSafeInteger(cents)||cents<=0||scaledQuantity<=0n||
    scaledQuantity>1_000_000_000_000n)return null;
  // cost_per_base_unit_micros = round(cents / units * 1,000,000).
  // units = scaledQuantity / 1,000,000.
  const numerator=BigInt(cents)*1_000_000_000_000n;
  const micro=(numerator+scaledQuantity/2n)/scaledQuantity;
  if(micro<=0n||micro>BigInt(Number.MAX_SAFE_INTEGER))return null;
  return {packageCostCents:cents,packageQuantity:Number(scaledQuantity)/1_000_000,
    micro:Number(micro)};
}
export function expectedOwnerPriceMicros(input:string):number|null{
  return ownerPackagePriceParts(input)?.micro??null;
}
export function parseOwnerPackageCost(input:string){
  const value=ownerPackagePriceParts(input);
  return value?{packageCostCents:value.packageCostCents,
    packageQuantity:value.packageQuantity}:null;
}
export const alexOwnerInputWrite:OwnerInputWriteRegistration={
  id:"menu.ingredient_price.manual.v1",
  fieldId:"ingredient.package_cost_and_quantity",
  prepare:(request,answer)=>{
    const amount=parseOwnerPackageCost(answer);
    if(!amount||!z.string().uuid().safeParse(request.writeContext.ingredientId).success||
      !z.string().uuid().safeParse(request.writeContext.productId).success||
      !["g","ml","each"].includes(request.writeContext.baseUnit)||
      !z.string().date().safeParse(request.writeContext.businessDay).success||
      !z.string().regex(/^[1-9][0-9]{0,18}$/).safeParse(request.writeContext.sourceRevision).success)
      return null;
    const label=`${(amount.packageCostCents/100).toFixed(2)} USD / ${amount.packageQuantity} ${request.writeContext.baseUnit}`;
    return {summary:{
      en:`Please confirm: save ${label} as an owner-reported ingredient price? (No receipt verified.)`,
      es:`Confirma: ¿guardar ${label} como precio indicado por el propietario? (Sin recibo verificado.)`,
      ar:`يرجى التأكيد: هل نحفظ ${label} كسعر ذكره المالك؟ (لم يتم التحقق من إيصال.)`,
    }};
  },
  verify:async(scope,request,answer)=>{
    const amount=parseOwnerPackageCost(answer);
    if(!amount)return false;
    const {identity}=await authorizedOwnerP1();
    if(identity.businessId!==scope.businessId||identity.currency!=="USD")return false;
    const source=await readAuthorizedAtomicP1SourceSnapshot();
    if(source.status!=="available"||source.snapshot.businessId!==scope.businessId)return false;
    const matches=source.snapshot.sources.ingredientPrices.filter(p=>
      p.ingredient_id===request.writeContext.ingredientId&&
      p.effective_from===request.writeContext.businessDay&&p.source==="manual");
    return matches.length===1&&matches[0].cost_per_base_unit_micros===
      expectedOwnerPriceMicros(answer);
  },
  apply:async(scope,request,answer)=>{
    const amount=parseOwnerPackageCost(answer);
    if(!amount)return {ok:false,reason:"invalid_owner_input"};
    const {identity}=await authorizedOwnerP1();
    if(identity.businessId!==scope.businessId||identity.currency!=="USD")
      return {ok:false,reason:"owner_scope_changed"};
    if(identity.asOf!==request.writeContext.businessDay)
      return {ok:false,reason:"source_changed"};
    const before=await readAuthorizedAtomicP1SourceSnapshot();
    if(before.status!=="available"||before.snapshot.businessId!==scope.businessId||
      before.snapshot.revision!==request.writeContext.sourceRevision)
      return {ok:false,reason:"source_changed"};
    const ingredientId=request.writeContext.ingredientId;
    const itemId=request.writeContext.productId;
    if(!before.snapshot.sources.ingredients.some(i=>i.id===ingredientId&&
      i.base_unit===request.writeContext.baseUnit)||
      !before.snapshot.sources.menu.some(m=>m.id===itemId&&m.is_active)||
      !before.snapshot.sources.recipes.some(r=>r.menu_item_id===itemId&&r.ingredient_id===ingredientId)||
      before.snapshot.sources.ingredientPrices.some(p=>p.ingredient_id===ingredientId&&
        p.effective_from<=request.writeContext.businessDay))
      return {ok:false,reason:"source_changed"};
    // Reuse the existing owner-authorized, unit-validated Menu action.
    const saved=await addManualIngredientPrice({ingredientId,...amount},{
      menuItemId:itemId,expectedRevision:request.writeContext.sourceRevision,
      businessDay:request.writeContext.businessDay,
    });
    if(!saved.ok)return {ok:false,reason:"write_failed"};
    const after=await readAuthorizedAtomicP1SourceSnapshot();
    const micro=Math.round(amount.packageCostCents/amount.packageQuantity*1000000);
    if(after.status!=="available"||after.snapshot.businessId!==scope.businessId||
      !after.snapshot.sources.ingredientPrices.some(p=>p.ingredient_id===ingredientId&&
        p.effective_from===request.writeContext.businessDay&&p.cost_per_base_unit_micros===micro&&p.source==="manual"))
      return {ok:false,reason:"verification_unavailable"};
    return {ok:true};
  },
};
export const ownerInputWrites=createOwnerInputWriteRegistry([alexOwnerInputWrite]);
