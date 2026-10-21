import "server-only";
import type {TrustedReadScope} from "@/lib/ai/supervisor/p2/registry";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type {OwnerInputRequest} from "@/lib/ai/supervisor/ownerInput/contracts";

/** A deterministic source-gap declaration. No model/keyword inspection is used to classify it. */
export async function alexMissingIngredientCost(scope:TrustedReadScope,
  selector?:{productId:string}|{exactName:string}):Promise<OwnerInputRequest|null>{
  if(scope.role!=="owner"||scope.identity.businessId!==scope.businessId||
    scope.identity.currency!=="USD"||!/^\d{4}-\d{2}-\d{2}$/.test(scope.identity.asOf))return null;
  const first=await readAuthorizedAtomicP1SourceSnapshot();
  if(first.status!=="available")return null;
  const snapshot=first.snapshot;
  if(snapshot.businessId!==scope.businessId||snapshot.currency!=="USD"||
    snapshot.timezone!==scope.identity.timezone||snapshot.truncated.menu||
    snapshot.truncated.ingredients||snapshot.truncated.ingredientPrices||
    snapshot.truncated.recipes||snapshot.truncated.ownerTotalCosts===true)return null;
  const menu=snapshot.sources.menu.filter(m=>m.is_active);
  const normalized=(s:string)=>s.normalize("NFC").trim().replace(/\s+/g," ").toLocaleLowerCase("en");
  const candidates=selector?
    menu.filter(m=>"productId" in selector?m.id===selector.productId:
      normalized(m.name)===normalized(selector.exactName)):
    menu.length===1?menu:[];
  if(candidates.length!==1)return null;
  const item=candidates[0];
  const lines=snapshot.sources.recipes.filter(r=>r.menu_item_id===item.id);
  if(!lines.length||lines.length>200||
    new Set(lines.map(l=>l.ingredient_id)).size!==lines.length)return null;
  // No request is necessary when Alex has a valid owner-total cost fallback.
  if(snapshot.sources.ownerTotalCosts?.some(c=>c.menu_item_id===item.id&&c.cost_cents>0))return null;
  const gaps=lines.filter(line=>{
    const prices=snapshot.sources.ingredientPrices.filter(p=>
      p.ingredient_id===line.ingredient_id&&p.effective_from<=scope.identity.asOf);
    return prices.length===0;
  });
  if(gaps.length!==1)return null;
  const missing=gaps[0];
  const ingredient=snapshot.sources.ingredients.filter(i=>i.id===missing.ingredient_id);
  if(ingredient.length!==1)return null;
  // Source churn invalidates the candidate, not just its eventual write.
  const second=await readAuthorizedAtomicP1SourceSnapshot();
  if(second.status!=="available"||second.snapshot.businessId!==snapshot.businessId||
    second.snapshot.revision!==snapshot.revision)return null;
  const name=ingredient[0].name.slice(0,80);
  const productName=item.name.slice(0,80);
  const unit=ingredient[0].base_unit;
  return {fieldId:"ingredient.package_cost_and_quantity",
    writeCapabilityId:"menu.ingredient_price.manual.v1",
    writeContext:{ingredientId:ingredient[0].id,productId:item.id,baseUnit:unit,
      sourceRevision:snapshot.revision,businessDay:scope.identity.asOf},
    question:{
      en:`What did you pay for ${name} in ${productName}, and how much did you buy?`,
      es:`¿Cuánto pagaste por ${name} para ${productName} y qué cantidad compraste?`,
      ar:`كم دفعت مقابل ${name} لمشروب ${productName} وما الكمية التي اشتريتها؟`,
    },
    input:{kind:"free_text",hint:{
      en:`Example: 4.50 / 946 (USD / ${unit}). Enter package price and quantity in ${unit}.`,
      es:`Ejemplo: 4.50 / 946 (USD / ${unit}). Precio del paquete y cantidad en ${unit}.`,
      ar:`مثال: 4.50 / 946 (دولار / ${unit}). أدخل سعر العبوة والكمية بوحدة ${unit}.`,
    }}};
}
