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
  const amounts=(text:string):{values:number[];ambiguous:boolean}=>{
    const normalized=decimalDigits(text.normalize("NFKC"));
    // Shared-unit alternatives ("10 or 20 cents", "10–20¢", and localized
    // equivalents) are ambiguous even though only the FINAL number carries
    // an explicit unit. Fail closed rather than silently selecting it.
    const unit=String.raw`(?:cents?|centavos?|céntimos?|سنت(?:ات)?|هللة|هللات|¢)`;
    const join=String.raw`(?:,?\s*(?:or|and|to|versus|vs\.?|o|u|y|أو|او|و)\s*|[/,–—-]\s*)`;
    const sharedUnit=new RegExp(String.raw`(?<![\p{L}\p{N}.])[0-9]{1,6}\s*${join}[0-9]{1,6}\s*${unit}(?![\p{L}\p{N}])`,"iu");
    const trailingAlternative=new RegExp(String.raw`(?<![\p{L}\p{N}.])[0-9]{1,6}\s*${unit}\s*${join}[0-9]{1,6}(?![\p{L}\p{N}.])`,"iu");
    const ambiguous=sharedUnit.test(normalized)||trailingAlternative.test(normalized);
    // Parse the owner source as exact integer cents. Never round a floating
    // model amount or ignore a minus sign before a dollar/cent quote.
    const signed=(raw:string)=>raw.replace(/\s/gu,"").replace(/[−–—]/gu,"-");
    const centsPattern=/(?<![\p{L}\p{N}.])([+\-−–—]?\s*[0-9]{1,6})[\s-]*(?:cents?|centavos?|céntimos?|سنت(?:ات)?|هللة|هللات|¢)(?![\p{L}\p{N}])/giu;
    const dollarPattern=/(?<![\p{L}\p{N}.])([+\-−–—]?\s*)\$\s*([0-9]{1,5})(?:\.([0-9]{1,2}))?(?![\p{L}\p{N}.])/giu;
    const centMatches=[...normalized.matchAll(centsPattern)];
    const dollarMatches=[...normalized.matchAll(dollarPattern)];
    const centQuotes=centMatches.map(m=>Number(signed(m[1])));
    const dollarQuotes=dollarMatches.map(m=>{
      const whole=Number(m[2]),fraction=Number((m[3]??"").padEnd(2,"0")||"0");
      return (signed(m[1]).startsWith("-")?-1:1)*(whole*100+fraction);
    });
    // Reject untyped numeric alternatives across the COMPLETE utterance, not
    // just numbers adjacent to a connector. E.g. "10 or maybe 20 cents",
    // "10 o quizás 20 centavos", and "١٠ أو ربما ٢٠ سنتات" all contain
    // an unaccounted-for 10 and cannot authorize a model-picked 20.
    // A recognized size/quantity is not a second price (e.g. "Latte 12 oz,
    // increase 10 cents"). The allowlist is for explicit NON-price units only;
    // an untyped number fails closed and requires owner clarification.
    const nonPriceUnits=/(?<![\p{L}\p{N}.])[0-9]{1,6}(?:[.,][0-9]{1,3})?[\s-]*(?:%|٪|percent(?:age)?|por[\s-]*ciento|بالمئة|في[\s-]*المئة|fl[\s-]*oz|oz|ounces?|onzas?|ml|millilit(?:er|re)s?|l|lit(?:er|re)s?|grams?|g|kg|كيلو|مل|أونصة|اونصة|days?|weeks?|months?|días?|semanas?|أيام|اسابيع)(?![\p{L}\p{N}])/giu;
    const permittedSpans=[...centMatches,...dollarMatches,...normalized.matchAll(nonPriceUnits)]
      .map(m=>({from:m.index,to:m.index+m[0].length}));
    const untypedAmount=[...normalized.matchAll(/(?<![\p{L}\p{N}])[0-9]+(?:\.[0-9]+)?(?![\p{L}\p{N}])/gu)]
      .some(m=>!permittedSpans.some(span=>m.index>=span.from&&
        m.index+m[0].length<=span.to));
    // Words can be price alternatives on EITHER side of the quoted amount.
    // Unlike the old blanket "or" scan, only a word denoting a NUMBER can
    // participate. This preserves unrelated choices ("sales stayed flat or
    // rose 10%") and Arabic words that merely contain the letters "او".
    // This lexicon does NOT interpret or authorize spoken amounts: it only
    // prevents the model from selecting one branch of an ambiguous quote.
    const spokenNumbers=/(?<![\p{L}\p{N}])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|dieciséis|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|صفر|واحد|واحدة|اثنان|اثنين|إثنين|عشر|عشرة|عشرين|عشرون|ثلاثون|ثلاثين|اربعون|أربعون|خمسون|خمسين|ستون|سبعون|ثمانون|تسعون|مئة|مائة|ألف)(?![\p{L}\p{N}])/giu;
    const connectors=/(?<![\p{L}\p{N}])(?:or|versus|vs|o|ou|أو|او|أم)(?![\p{L}\p{N}])/iu;
    // If the intervening text explicitly identifies a different quantity
    // (e.g. "one or two days"), it is not a price alternative.
    const typedOtherUnit=/(?<![\p{L}\p{N}])(?:times?|days?|weeks?|months?|years?|cups?|units?|pieces?|percent|percentage|por\s+ciento|oz|ounces?|ml|liters?|litres?|d[ií]as?|semanas?|meses|أيام|اسابيع|بالمئة)(?![\p{L}\p{N}])|[%٪]/iu;
    const spokenAlternative=[...centMatches,...dollarMatches].some(price=>
      [...normalized.matchAll(spokenNumbers)].some(word=>{
        const from=word.index<price.index?word.index+word[0].length:price.index+price[0].length;
        const to=word.index<price.index?price.index:word.index;
        const between=normalized.slice(from,to);
        return between.length<=100&&!/[.!?؟;\n]/u.test(between)&&
          connectors.test(between)&&!typedOtherUnit.test(between);
      }));
    return {values:[...centQuotes,...dollarQuotes],
      ambiguous:ambiguous||untypedAmount||spokenAlternative};
  };
  const currentAmounts=amounts(current);
  if(currentAmounts.ambiguous)return false;
  const previousAmounts=currentAmounts.values.length?null:amounts(previous??"");
  if(previousAmounts?.ambiguous)return false;
  const selected=currentAmounts.values.length?currentAmounts.values:previousAmounts?.values??[];
  return selected.length>0&&selected.every(value=>value===candidate);
}
/** Product must be named in owner text. An unsized name that maps to two menu
 * variants is ambiguous even if the model guessed a valid UUID. */
export function ownerNamedUniqueProduct(current:string,previous:string|undefined,
  selectedId:string,catalog:readonly {id:string;name:string;baseName:string}[]):boolean{
  // An explicit product in THIS turn overrides unrelated products discussed
  // earlier. Only a product-free follow-up can inherit prior context.
  const resolve=(ownerText:string):boolean|null=>{
    const text=normalizedDrinkName(ownerText);
    const seen=(name:string)=>{
      const term=normalizedDrinkName(name);
      return term.length>=2&&(" "+text+" ").includes(" "+term+" ");
    };
    const exact=catalog.filter(x=>seen(x.name));
    if(exact.length)return exact.length===1&&exact[0].id===selectedId;
    const based=catalog.filter(x=>seen(x.baseName));
    if(based.length)return based.length===1&&based[0].id===selectedId;
    // One distinctive token may identify a uniquely named item (e.g.,
    // "latte" for "Iced Latte"), but never guess among menu size variants.
    const ownerWords=new Set(text.split(" "));
    const partial=catalog.filter(item=>normalizedDrinkName(item.name).split(" ")
      .some(word=>word.length>=4&&ownerWords.has(word)));
    return partial.length?partial.length===1&&partial[0].id===selectedId:null;
  };
  return resolve(current)??resolve(previous??"")??false;
}
