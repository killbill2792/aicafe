/** A saved owner message is an authorization only for an explicit, present purchase command.
 * Attachment text and model tool arguments MUST NOT be passed here. This rejects
 * hypothetical, negated and exploratory language; uncertain cases use approval cards. */
export function authorizesInventoryWrite(ownerText:string,hasAttachments:boolean):boolean{
 const t=ownerText.normalize("NFKC").toLocaleLowerCase().trim();
 if(!t||t.length>4000||t.includes("?")||/\b(if|what if|suppose|maybe|might|could|would|should|hypothetical|preview|draft|review only|do not|don't|never|cancel|not yet|planning|plan to)\b/u.test(t))
  return false;
 const explicit=/\b(record|add|update|log|increase|save|post)\b/u.test(t)&&
   /\b(inventory|stock|purchases?|receipt|bill|invoice|items?)\b/u.test(t);
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
