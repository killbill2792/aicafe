import "server-only";
import {createHash} from "node:crypto";
import type {TrustedReadScope} from "@/lib/ai/supervisor/p2/registry";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import type {OwnerInputRequest} from "@/lib/ai/supervisor/ownerInput/contracts";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

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
  // Multiple absent prices are resolved one validated owner fact at a time.
  // This re-enters the original read after each confirmed write, never
  // claims a complete cost basis from only the first supplied price.
  if(gaps.length===0)return null;
  const missing=[...gaps].sort((a,b)=>a.ingredient_id.localeCompare(b.ingredient_id))[0];
  const ingredient=snapshot.sources.ingredients.filter(i=>i.id===missing.ingredient_id);
  if(ingredient.length!==1)return null;
  // Source churn invalidates the candidate, not just its eventual write.
  const second=await readAuthorizedAtomicP1SourceSnapshot();
  if(second.status!=="available"||second.snapshot.businessId!==snapshot.businessId||
    second.snapshot.revision!==snapshot.revision)return null;
  // Preserve the selected variant across the ingredient-price confirmation.
  // This is only a catalog identity proof, never a cached price or cost.
  const db=await createServerSupabaseClient();
  const {data:matchingMenu,error:menuError}=await db.from("menu_items")
    .select("id,name,base_name,size_label,price_cents,is_active")
    .eq("business_id",scope.businessId).eq("id",item.id).limit(2);
  if(menuError||!matchingMenu||matchingMenu.length!==1||
    matchingMenu[0].is_active!==true||matchingMenu[0].name!==item.name||
    matchingMenu[0].price_cents!==item.price_cents)return null;
  const productFingerprint=catalogIdentityFingerprint(matchingMenu[0]);
  const name=ingredient[0].name.slice(0,80);
  const productName=item.name.slice(0,80);
  const unit=ingredient[0].base_unit;
  return {fieldId:"ingredient.package_cost_and_quantity",
    writeCapabilityId:"menu.ingredient_price.manual.v1",
    writeContext:{ingredientId:ingredient[0].id,productId:item.id,baseUnit:unit,
      ["catalogIdentity:"+item.id]:productFingerprint,
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


/** Canonical catalog cardinality is the sole multi-match signal.
 * Query text is a typed read selector, never a keyword guess about the owner. */
export async function alexProductCatalogResolution(scope:TrustedReadScope,
  selector:{productId:string}|{exactName:string}|undefined):Promise<OwnerInputRequest|{productId:string}|{kind:"zero_match";exactName:string;sourceRevision:string}|null>{
  // Only the live investigation owns a durable pending-question response.
  // Legacy P2/shadow reads have no owner-answer submission lifecycle and
  // must retain their existing typed unavailable/quality reason behavior.
  if(scope.durableOwnerInput!==true||!scope.ownerClause?.trim()||!selector||!("exactName" in selector)||
    scope.role!=="owner"||scope.identity.businessId!==scope.businessId)return null;
  const first=await readAuthorizedAtomicP1SourceSnapshot();
  if(first.status!=="available"||first.snapshot.businessId!==scope.businessId||
    first.snapshot.truncated.menu)return null;
  const normalized=(s:string)=>s.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("en");
  // Match against a canonical, tenant-scoped projection that retains the
  // product family and variant labels. Confirm every row against the atomic
  // source before issuing a card, even when exact names already match.
  const db=await createServerSupabaseClient();
  const {data:projection,error}=await db.from("menu_items")
    .select("id,name,base_name,size_label,price_cents,is_active")
    .eq("business_id",scope.businessId).limit(501);
  if(error||!projection||projection.length!==first.snapshot.sources.menu.length)return null;
  const sourceById=new Map(first.snapshot.sources.menu.map(row=>[row.id,row]));
  if(!projection.every(item=>{
    const source=sourceById.get(item.id);
    return source&&source.name===item.name&&source.is_active===item.is_active&&
      source.price_cents===item.price_cents;
  }))return null;
  const matches=projection.filter(item=>item.is_active&&
    (normalized(item.name)===normalized(selector.exactName)||
     normalized(item.base_name??item.name)===normalized(selector.exactName)));
  if(matches.length>30)return null;
  const latest=await readAuthorizedAtomicP1SourceSnapshot();
  if(latest.status!=="available"||latest.snapshot.businessId!==first.snapshot.businessId||
    latest.snapshot.revision!==first.snapshot.revision)return null;
  // A negative catalog result does not establish intent to introduce a
  // product. The semantic Supervisor may still ask a reviewed new-product
  // question, but a simple "is this on my menu?" must be answered as absent.
  // A source-complete negative result is still useful information. Ordinary
  // catalog Q&A must not be misclassified as an intention to create a product.
  // The live Supervisor can ask for new-item details only when the OWNER goal
  // warrants it; this result itself authorizes no write.
  if(matches.length===0)return {kind:"zero_match",exactName:selector.exactName,
    sourceRevision:first.snapshot.revision};
  if(matches.length===1)return {productId:matches[0].id};
  const copy={en:en.SupervisorOwnerHelp,es:es.SupervisorOwnerHelp,ar:ar.SupervisorOwnerHelp};
  const options=matches.map(m=>({id:m.id,label:Object.fromEntries(
    (["en","es","ar"] as const).map(locale=>[locale,m.name+" — "+
      (m.price_cents===null?copy[locale].priceUnknown:
        new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(m.price_cents/100))])
  ) as Record<"en"|"es"|"ar",string>}));
  return {mode:"resolve",fieldId:"owner.clarification",
    writeCapabilityId:"platform.owner_input.resolve.v1",
    writeContext:{domain:"menu",catalogRevision:first.snapshot.revision,
      ...Object.fromEntries(matches.map(item=>[
        "catalogIdentity:"+item.id,catalogIdentityFingerprint(item)]))},
    question:{
      en:en.SupervisorOwnerHelp.catalogMultipleQuestion,
      es:es.SupervisorOwnerHelp.catalogMultipleQuestion,
      ar:ar.SupervisorOwnerHelp.catalogMultipleQuestion,
    },input:{kind:"options",options}};
}

/** Only stable catalog identity belongs in the choice fingerprint. Price
 * updates and unrelated business source revisions must NOT invalidate it. */
export function catalogIdentityFingerprint(item:{
  id:string;name:string;base_name?:string|null;size_label?:string|null;
}):string{
  return createHash("sha256").update(JSON.stringify([
    item.id,item.name,item.base_name??null,item.size_label??null,
  ])).digest("hex");
}

/** Verify a previously issued owner option against current authoritative
 * menu identity, not simply an active UUID or a business-wide revision. */
export async function alexCatalogChoiceStillValid(businessId:string,
  productId:string,issuedFingerprint:string):Promise<boolean>{
  if(!/^[0-9a-f]{64}$/.test(issuedFingerprint))return false;
  const snapshot=await readAuthorizedAtomicP1SourceSnapshot();
  if(snapshot.status!=="available"||snapshot.snapshot.businessId!==businessId||
    snapshot.snapshot.truncated.menu)return false;
  const canonical=snapshot.snapshot.sources.menu.filter(m=>m.id===productId&&m.is_active);
  if(canonical.length!==1)return false;
  const db=await createServerSupabaseClient();
  const {data,error}=await db.from("menu_items")
    .select("id,name,base_name,size_label,price_cents,is_active")
    .eq("business_id",businessId).eq("id",productId).limit(2);
  if(error||!data||data.length!==1)return false;
  const current=data[0];
  return current.is_active===true&&current.name===canonical[0].name&&
    current.price_cents===canonical[0].price_cents&&
    catalogIdentityFingerprint(current)===issuedFingerprint;
}
