import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";

export type PurchaseNeed={itemName:string;ingredientId:string|null;quantity:number;unit:string};
export type Ingredient={id:string;name:string;base_unit:string};
export type SupplierQuote={
 id:string;supplier_name:string;item_name:string;ingredient_id:string|null;
 price_cents:number;package_count:number;package_unit:string;currency_code:string|null;
 source_kind:string;quoted_on:string;valid_until:string|null;available_status:string;
 available_checked_at:string|null;delivery_on:string|null;
};
export type PurchaseLine={quoteId:string;ingredientId:string;itemName:string;neededBaseQuantity:number;
 baseUnit:BaseUnit;packs:number;packQuantity:number;packUnit:string;priceCents:number;
 lineSubtotalCents:number;quotedOn:string;deliveryOn:string|null};
export type PurchaseOffer={supplierName:string;currency:string;subtotalCents:number;
 totalCents:null;shippingCents:null;taxCents:null;lines:PurchaseLine[];
 limitations:string[]};
export type PurchasePlan={offers:PurchaseOffer[];missing:string[];
 comparison:"subtotal_only"|"incomplete";truncated:boolean};
const norm=(s:string)=>s.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu," ");
const validMoney=(v:number)=>Number.isSafeInteger(v)&&v>0&&v<=100000000;
const ageDays=(a:string,b:string)=>Math.round((Date.parse(a+"T00:00:00Z")-Date.parse(b+"T00:00:00Z"))/86400000);

/** Pure, grounded purchasing math. A supplier is a feasible cart only when it has
 * a current, available and currency-matching firm quote for EVERY requested item.
 * "Lowest subtotal" is not "best total": shared freight and tax stay unknown. */
export function planSupplierOrder(input:{
 needs:readonly PurchaseNeed[];ingredients:readonly Ingredient[];quotes:readonly SupplierQuote[];
 currency:string|null;today:string;neededBy:string|null;preferredSupplier:string|null;
 truncated?:boolean;
}):PurchasePlan{
 const missing=new Set<string>();
 if(input.truncated)missing.add("supplier_quote_history_truncated");
 if(!input.currency||!/^[A-Z]{3}$/u.test(input.currency))missing.add("cafe_currency_missing");
 if(input.neededBy&&input.neededBy<input.today)missing.add("requested_delivery_in_past");
 if(!input.needs.length||input.needs.length>10)missing.add("invalid_purchase_lines");
 const needs=input.needs.map(n=>{
  const matches=input.ingredients.filter(i=>i.id===n.ingredientId||
    (!n.ingredientId&&norm(i.name)===norm(n.itemName)));
  const ingredient=matches.length===1?matches[0]:null;
  if(!ingredient||norm(ingredient.name)!==norm(n.itemName)){
   missing.add("ingredient_unknown_or_ambiguous:"+n.itemName);return null;
  }
  if(!["g","ml","each"].includes(ingredient.base_unit)){
   missing.add("ingredient_base_unit_invalid:"+n.itemName);return null;
  }
  const base=ingredient.base_unit as BaseUnit;
  const quantityBase=packBaseQuantity(n.quantity,n.unit,base);
  if(quantityBase===null){
   missing.add("requested_unit_not_convertible:"+n.itemName);return null;
  }
  return {n,ingredient,base,quantityBase};
 });
 if(needs.some(x=>!x)||missing.has("supplier_quote_history_truncated")||
   missing.has("cafe_currency_missing")||missing.has("requested_delivery_in_past"))
  return {offers:[],missing:[...missing],comparison:"incomplete",truncated:Boolean(input.truncated)};
 const groups=new Map<string,{name:string;quotes:SupplierQuote[]}>();
 for(const quote of input.quotes){
  if(!quote.supplier_name.trim())continue;
  const key=norm(quote.supplier_name);
  const group=groups.get(key)??{name:quote.supplier_name,quotes:[]};
  group.quotes.push(quote);groups.set(key,group);
 }
 const offers:PurchaseOffer[]=[];
 for(const [key,group] of groups){
  if(input.preferredSupplier&&norm(input.preferredSupplier)!==key)continue;
  const lines:PurchaseLine[]=[];
  for(const need of needs){
   if(!need)continue;
   const candidates:PurchaseLine[]=[];
   for(const quote of group.quotes){
    if((quote.ingredient_id&&quote.ingredient_id!==need.ingredient.id)||
       norm(quote.item_name)!==norm(need.ingredient.name))continue;
    let reason:string|null=null;
    if(!validMoney(quote.price_cents)||!Number.isSafeInteger(quote.package_count)||
       quote.package_count<=0)reason="invalid_quote";
    else if(!quote.currency_code)reason="quote_currency_unconfirmed";
    else if(quote.currency_code!==input.currency)reason="currency_incomparable";
    else if(quote.source_kind==="public_listing")reason="unverified_public_listing";
    else if(quote.quoted_on>input.today||quote.valid_until&&quote.valid_until<input.today)
      reason="quote_expired_or_future";
    else if(quote.available_status!=="confirmed"||!quote.available_checked_at)
      reason="availability_unconfirmed";
    else if(quote.available_checked_at>input.today||
      ageDays(input.today,quote.available_checked_at)>7)
      reason="availability_stale";
    else if(input.neededBy&&(!quote.delivery_on||quote.delivery_on>input.neededBy))
      reason="delivery_not_confirmed";
    const perPack=packBaseQuantity(quote.package_count,quote.package_unit,need.base);
    if(perPack===null)reason="package_conversion_missing";
    if(reason){missing.add(reason+":"+group.name+":"+need.ingredient.name);continue;}
    const packs=Math.ceil(need.quantityBase/perPack!);
    const lineSubtotalCents=packs*quote.price_cents;
    if(!Number.isSafeInteger(packs)||packs<1||packs>100000||
       !Number.isSafeInteger(lineSubtotalCents)||lineSubtotalCents>1000000000){
      missing.add("quantity_or_price_overflow:"+need.ingredient.name);continue;
    }
    candidates.push({quoteId:quote.id,ingredientId:need.ingredient.id,
      itemName:need.ingredient.name,neededBaseQuantity:need.quantityBase,baseUnit:need.base,
      packs,packQuantity:quote.package_count,packUnit:quote.package_unit,
      priceCents:quote.price_cents,lineSubtotalCents,quotedOn:quote.quoted_on,
      deliveryOn:quote.delivery_on});
   }
   candidates.sort((a,b)=>a.lineSubtotalCents-b.lineSubtotalCents||a.quoteId.localeCompare(b.quoteId));
   if(candidates[0])lines.push(candidates[0]);
   else missing.add("supplier_does_not_cover_item:"+group.name+":"+need.ingredient.name);
  }
  if(lines.length!==input.needs.length)continue;
  const subtotalCents=lines.reduce((sum,line)=>sum+line.lineSubtotalCents,0);
  if(!Number.isSafeInteger(subtotalCents)||subtotalCents>1000000000){
   missing.add("cart_total_overflow:"+group.name);continue;
  }
  offers.push({supplierName:group.name,currency:input.currency!,subtotalCents,
   shippingCents:null,taxCents:null,totalCents:null,lines,
   limitations:["owner_reported_not_supplier_verified","shipping_unknown","tax_unknown",
     "landed_total_not_comparable"]});
 }
 offers.sort((a,b)=>a.subtotalCents-b.subtotalCents||
   a.supplierName.localeCompare(b.supplierName));
 if(!offers.length)missing.add("no_complete_supplier_cart");
 return {offers,missing:[...missing],comparison:offers.length?"subtotal_only":"incomplete",
  truncated:Boolean(input.truncated)};
}