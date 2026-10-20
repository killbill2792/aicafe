/** Validation of owner-stated prices and product names, not an intent router.
 * A model may choose a registered inert-proposal tool semantically, but cannot
 * manufacture a price or select an ambiguous catalog variant. */
export function normalizedDrinkName(value:string):string{
  return value.toLocaleLowerCase("en").normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu," ").trim();
}
function decimalDigits(value:string):string{
  return value.replace(/[٠-٩]/gu,x=>String(x.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/gu,x=>String(x.charCodeAt(0)-0x6f0));
}
/** Verify the proposed integer-cent delta is a single exactly owner-authored
 * amount in the current turn, or in the most recent owner turn for an explicit
 * follow-up. Do not use model-generated amounts as independent evidence. */
export function ownerQuotedPriceDelta(current:string,previous:string|undefined,
  candidate:number):boolean{
  if(!Number.isSafeInteger(candidate)||candidate<1||candidate>100000)return false;
  const amounts=(text:string)=>{
    const normalized=decimalDigits(text.normalize("NFKC"));
    const pattern=/(?<![\p{L}\p{N}.])([0-9]{1,6})[\s-]*(?:cents?|centavos?|céntimos?|سنت(?:ات)?|هللة|هللات)(?![\p{L}\p{N}])/giu;
    return [...normalized.matchAll(pattern)].map(m=>Number(m[1]));
  };
  const currentAmounts=amounts(current);
  const selected=currentAmounts.length?currentAmounts:amounts(previous??"");
  return selected.length===1&&selected[0]===candidate;
}
/** Product must be named in owner text. An unsized name that maps to two menu
 * variants is ambiguous even if the model guessed a valid UUID. */
export function ownerNamedUniqueProduct(current:string,previous:string|undefined,
  selectedId:string,catalog:readonly {id:string;name:string;baseName:string}[]):boolean{
  const text=normalizedDrinkName([current,previous??""].join(" "));
  const seen=(name:string)=>{
    const term=normalizedDrinkName(name);
    return term.length>=2&&(" "+text+" ").includes(" "+term+" ");
  };
  const exact=catalog.filter(x=>seen(x.name));
  if(exact.length)return exact.length===1&&exact[0].id===selectedId;
  const based=catalog.filter(x=>seen(x.baseName));
  if(based.length)return based.length===1&&based[0].id===selectedId;
  // Owners often say "latte" where a sole catalog item is "Iced Latte".
  // Permit a unique meaningful product-name token, NEVER an ambiguous size
  // or the model's unsupported guess when multiple drinks share that token.
  const ownerWords=new Set(text.split(" "));
  const partial=catalog.filter(item=>normalizedDrinkName(item.name).split(" ")
    .some(word=>word.length>=4&&ownerWords.has(word)));
  return partial.length===1&&partial[0].id===selectedId;
}
