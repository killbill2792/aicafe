/** A saved owner message is an authorization only for an explicit, present purchase command.
 * Attachment text and model tool arguments MUST NOT be passed here. This rejects
 * hypothetical, negated and exploratory language; uncertain cases use approval cards. */
export function authorizesInventoryWrite(ownerText:string,hasAttachments:boolean):boolean{
 const t=ownerText.normalize("NFKC").toLocaleLowerCase().trim();
 if(!t||t.length>4000||t.includes("?")||/\b(if|what if|suppose|maybe|might|could|would|should|hypothetical|preview|draft|review only|do not|don't|never|cancel|not yet|planning|plan to|actually|correction|correct|instead|meant|undo)\b/u.test(t))
  return false;
 const action=/\b(record|add|update|log|increase|save|post|put|enter)\b/u.test(t);
 const stockTarget=/\b(inventory|stock)\b/u.test(t);
 const purchasesTarget=/\b(purchases?|ingredients?|supplies)\b/u.test(t);
 const explicit=action&&(stockTarget||
   purchasesTarget&&/\b(record|add|log|post|save|enter)\b/u.test(t));
 const directBought=/\b(i|we)\s+(?:just\s+)?(?:bought|purchased)\s+\d+(?:[.,]\d+)?\s+(?:[a-z]+(?:\s+|$)){1,5}/u.test(t);
 // A naked receipt upload describes evidence; it does not grant permission.
 return explicit||(directBought&&!hasAttachments);
}

/** Typed purchases must match explicit quantity, unit and item in the original
 * owner utterance before an unconfirmed model-proposed line can change stock.
 * Ambiguous written numbers or package units fall back to owner review. */
export function ownerTextSupportsTypedLine(
 ownerText:string,line:{name:string;quantity:number;unit:string}
):boolean{
 if(!Number.isFinite(line.quantity)||line.quantity<=0||!line.unit.trim()||!line.name.trim())
  return false;
 const normalize=(s:string)=>s.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9.]+/gu," ").trim();
 const text=normalize(ownerText),name=normalize(line.name),unit=normalize(line.unit);
 if(!text||!name||!unit||!(" "+text+" ").includes(" "+name+" "))return false;
 const aliases:Record<string,string[]>={
  gal:["gal","gallon","gallons"],lb:["lb","lbs","pound","pounds"],
  oz:["oz","ounce","ounces"],kg:["kg","kilogram","kilograms"],
  g:["g","gram","grams"],l:["l","liter","liters","litre","litres"],
  ml:["ml","milliliter","milliliters"],ea:["ea","each","unit","units"],
  pcs:["pcs","pieces","piece"],case:["case","cases"]
 };
 const allowed=new Set(aliases[unit]??[unit]);
 const words=text.split(" "),nameWords=name.split(" ");
 const blockers=new Set(["and","or","plus","but","then","also","another"]);
 const allUnits=new Set(Object.values(aliases).flat());
 // A quantity/unit mentioned somewhere else in a multi-item sentence must
 // never authorize a mismatched item. Match the ingredient in the same clause.
 return words.some((word,index)=>{
  if(word!==String(line.quantity))return false;
  for(let j=index+1;j<Math.min(words.length,index+4);j++){
   if(!allowed.has(words[j]))continue;
   for(let k=j+1;k<Math.min(words.length,j+7);k++){
    const between=words.slice(j+1,k);
    if(between.some(v=>blockers.has(v)||allUnits.has(v)||/^\d/u.test(v)))break;
    if(nameWords.every((w,n)=>words[k+n]===w))return true;
   }
  }
  return false;
 });
}

/** A model cannot invent a typed-purchase cost or backdate an inventory
 * movement. The owner turn is the authority, and the café-local day is trusted
 * server context. Ambiguous currency/line attribution stays in owner review.
 */
export function ownerTextSupportsTypedFinancials(
 ownerText:string,line:{costCents:number|null;date:string},
 cafeToday:string,lineCount:number,currency:string|null
):boolean{
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(line.date)||
    !/^\d{4}-\d{2}-\d{2}$/u.test(cafeToday))return false;
 const text=ownerText.normalize("NFKC").toLocaleLowerCase();
 const dates=[...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].map(m=>m[0]);
 let allowedDate=cafeToday;
 if(dates.length){
  if(new Set(dates).size!==1)return false;
  allowedDate=dates[0];
 }else if(/\byesterday\b/u.test(text)){
  const shifted=new Date(cafeToday+"T12:00:00Z");
  if(Number.isNaN(shifted.valueOf()))return false;
  shifted.setUTCDate(shifted.getUTCDate()-1);
  allowedDate=shifted.toISOString().slice(0,10);
 }else if(/\b(tomorrow|last|next|ago|earlier|previous|on monday|on tuesday|on wednesday|on thursday|on friday|on saturday|on sunday)\b/u.test(text))
  return false;
 if(line.date!==allowedDate)return false;
 // The authoritative café currency is supplied by the owner-scoped business
 // record. Do not assume a dollar currency or accept a mismatched money glyph.
 const currencyValid=typeof currency==="string"&&/^[A-Z]{3}$/u.test(currency);
 let symbol:string|null=null;
 if(currencyValid){
  try{
   symbol=new Intl.NumberFormat("en",{style:"currency",currency:currency!})
    .formatToParts(1).find(part=>part.type==="currency")?.value??null;
  }catch{return false;}
 }
 const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
 // Count physical purchase quantities in the ORIGINAL saved owner message, not
 // model-controlled propose_purchases batching. A shared "$45 total" across
 // milk + beans must remain in review even if sent as two one-line calls.
 const ownerQuantityMentions=[...text.matchAll(
  /\b\d+(?:\.\d+)?\s*(?:gal(?:lon)?s?|lbs?|pounds?|oz|ounces?|kg|kilograms?|g|grams?|l|liters?|litres?|ml|milliliters?|ea|each|units?|pcs|pieces?|cases?)\b/giu
 )].length;
 const multiLineOwner=ownerQuantityMentions!==1||
  /\b(?:and|plus|also)\s+\d+(?:\.\d+)?\b/iu.test(text);
 const amountPattern=currencyValid&&symbol?
   new RegExp("(?:"
     +escape(symbol)+"|\\b"+escape(currency!.toLocaleLowerCase())+"\\s*)"
     +"(\\d{1,7})(?:\\.(\\d{1,2}))?(?![\\d.,])","giu"):null;
 const amounts=amountPattern?[...text.matchAll(amountPattern)]:[];
 const hasOtherMoney=/\p{Sc}/u.test(text)&&amounts.length===0;
 // No owner-provided price: a model may not fill in a fabricated cost.
 if(amounts.length===0)
  return line.costCents===null&&!hasOtherMoney&&
   !/\b(?:paid|spent|cost|price)\s+(?:about\s+)?\d/u.test(text);
 if(!currencyValid||lineCount!==1||multiLineOwner||amounts.length!==1||
   line.costCents===null||!Number.isSafeInteger(line.costCents)||line.costCents<0||
   /\b(per|each|unit price|discount|tax|tip|approx|about)\b/u.test(text))return false;
 const [,whole,fraction=""]=amounts[0];
 const cents=Number(whole)*100+Number(fraction.padEnd(2,"0"));
 return Number.isSafeInteger(cents)&&line.costCents===cents;
}

/** An order or invoice proves purchase intent, not physical stock receipt.
 * A saved owner declaration of delivery authorizes inventory-only recording.
 * A negated/undelivered statement always falls back to owner review. */
export function receivedPurchaseDocument(kind:"receipt"|"invoice"|"purchase_order"|"unknown"|null|undefined,
 ownerText:string):boolean{
 if(kind==="receipt")return true;
 if(kind!=="purchase_order"&&kind!=="invoice")return false;
 const text=ownerText.normalize("NFKC").toLocaleLowerCase();
 if(/\b(not received|not delivered|not yet|pending|expected|awaiting|unreceived|haven't received|hasn't arrived)\b/u.test(text))
   return false;
 // Receiving an invoice or PO is not proof of receiving physical stock.
 // Non-receipt documents require an explicit delivery signal AND a physical
 // goods noun, not just the word "received" anywhere in the conversation.
 const arrival=/\b(received|delivered|collected|picked up|picked-up|arrived)\b/u.test(text);
 const physicalGoods=/\b(goods|items|products|stock|supplies|ingredients|groceries|shipment|delivery)\b/u.test(text);
 const paperworkReceived=/\b(received|collected)\s+(?:(?:this|the|my|an?|new)\s+)?(?:invoice|bill|statement|purchase order)\b/u.test(text);
 return arrival&&physicalGoods&&!paperworkReceived;
}
export function isPurchaseCorrection(ownerText:string):boolean{
 return /\b(actually|correction|correct|instead|meant|undo|edit previous|change earlier)\b/iu.test(ownerText);
}
