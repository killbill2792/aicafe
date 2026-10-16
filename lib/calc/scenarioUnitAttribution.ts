/** Reject model-chosen dimensions that do not occur next to the owner's number.
 * This is source-free and intentionally conservative for unqualified values.
 */
const normalize=(s:string)=>s.normalize("NFKC").toLocaleLowerCase()
  .replace(/[\u0660-\u0669\u06F0-\u06F9]/gu,c=>{
    const n=c.codePointAt(0)!;return String(n>=0x6f0?n-0x6f0:n-0x660);
  }).replace(/(?<=\d)[,\u066B\u066C](?=\d)/gu,".");
const minutes=/\b(?:mins?|minutes?|minutos?|minuto)\b|دقيق(?:ة|تين)|دقائق/iu;
const hours=/\b(?:hours?|hrs?|horas?|hora)\b|ساعات|ساعة/iu;
const ounces=/\b(?:oz|ounces?|fl\s*oz|onzas?)\b|أونص(?:ة|ات)/iu;
const gallons=/\b(?:gallons?|gal|galones?)\b|غالون/iu;
const ratio=/%|٪|\b(?:percent|percentage|por ciento|porcentaje)\b|بالمئة|بالمائة|في المئة/iu;
const money=/[$€£]|\b(?:dollars?|dólares?|dolares?|cents?|centavos?)\b|دولار|سنت/iu;
const items=/\b(?:items?|units?|products?|drinks?|cups?|lattes?|coffees?|beverages?|bebidas?|tazas?|unidades?|productos?)\b|أكواب|كوب|مشروب|مشروبات|وحدات/iu;
const word=/[\p{L}\p{N}]/u;
const multiplier=/\b(?:times?|twice|double|multiply|multiplied|multiplier|factor|divide|divided|dividing|divisor|halve|halved|veces|multiplicar|multiplicado|dividir|dividido|división|division|entre)\b|ضعف|مرات|مرة|قسمة|اقسم|قسّم|تقسيم/iu;
export function ownerQuotedUnitMatches(message:string,quoted:string,unit:string):boolean{
  const text=normalize(message),number=normalize(quoted);
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(number))return false;
  const hits:Set<string>[]=[];
  for(let start=text.indexOf(number);start>=0;start=text.indexOf(number,start+1)){
    const end=start+number.length;
    if(start>0&&(word.test(text[start-1])||/[.,\u066b\u066c]/iu.test(text[start-1]))||
      end<text.length&&(word.test(text[end])||/[.,\u066b\u066c]/iu.test(text[end])))continue;
    const before=text.slice(Math.max(0,start-12),start).split(/[;,.،!؟]/u).at(-1)??"";
    const after=(text.slice(end,end+66).split(/(?:\b(?:and|but|while|then|y|pero)\b|[;,.،!؟]|\b\d+(?:\.\d+)?\b)/iu)[0]??"")
      // "$" attached to the NEXT number is not this number's currency.
      .replace(/[$€£]\s*$/u,"");
    const nearby=before+" "+after;
    const found=new Set<string>();
    if(minutes.test(nearby))found.add("minute");
    if(hours.test(nearby))found.add("hour");
    if(ounces.test(nearby))found.add("US_fl_oz");
    if(gallons.test(nearby))found.add("US_gallon");
    if(ratio.test(nearby))found.add("ratio_bps");
    if(money.test(nearby))found.add("money");
    const scalarContext=text.slice(Math.max(0,start-75),start)
      .split(/\d+(?:\.\d+)?/u).at(-1)??"";
    const scalarWords=scalarContext.split(/\b(?:and|or|but|y|pero)\b|[;,.،!؟]/iu).at(-1)??"";
    if(found.size===0 && (multiplier.test(scalarWords)||multiplier.test(after)))
      found.add("scalar");
    // A currency sign immediately adjacent to THIS quoted amount is
    // authoritative; a preceding percentage belongs to another operand.
    if(/[$€£]\s*$/u.test(before)){
      found.clear();
      found.add("money");
    }
    const genericPlural=/^\s*(?:(?:more|additional|extra|paid|new|más|mas|أكثر|إضافية)\s+){0,3}[\p{L}]+s\b/iu;
    // "fluid ounces per cup" is volume, not a count of cups. An
    // explicit dimension always takes precedence over incidental nouns.
    if(found.size===0&&(items.test(nearby)||genericPlural.test(after)))
      found.add("item");
    // A unit immediately following this number takes precedence over a
    // previous operand in the same sentence: "10% of 25 items".
    const direct=new Set<string>();
    if(minutes.test(after))direct.add("minute");
    if(hours.test(after))direct.add("hour");
    if(ounces.test(after))direct.add("US_fl_oz");
    if(gallons.test(after))direct.add("US_gallon");
    if(ratio.test(after))direct.add("ratio_bps");
    if(money.test(after))direct.add("money");
    // Currency words with "per hour/item" are monetary rates, not hours/items.
    // The separate monetary-dimension validator proves the exact rate qualifier.
    if(direct.has("money")&&direct.size>1){direct.clear();direct.add("money");}
    if(direct.size===0&&multiplier.test(after))direct.add("scalar");
    if(direct.size===0&&(items.test(after)||genericPlural.test(after)))
      direct.add("item");
    if(direct.size===1){
      found.clear();
      for(const dimension of direct)found.add(dimension);
    }
    if(/[$€£]\s*$/u.test(before)){
      found.clear();found.add("money");
    }
    hits.push(found);
  }
  const expected=unit.startsWith("USD_")?"money":unit;
  const named=hits.some(x=>x.size===1&&x.has(expected))&&
    hits.every(x=>x.size===0||(x.size===1&&x.has(expected)));
  return named&&(!unit.startsWith("USD_")||
    ownerQuotedMoneyDimensionMatches(text,number,unit));
}
/** A dollar total and a dollar rate are different typed quantities.
 * Require an explicit matching per-unit qualifier for a monetary rate.
 */
function ownerQuotedMoneyDimensionMatches(text:string,number:string,unit:string):boolean{
  const resolved:boolean[]=[];
  for(let start=text.indexOf(number);start>=0;start=text.indexOf(number,start+1)){
    const end=start+number.length;
    if(start>0&&(word.test(text[start-1])||/[.,\u066b\u066c]/iu.test(text[start-1]))||
      end<text.length&&(word.test(text[end])||/[.,\u066b\u066c]/iu.test(text[end])))continue;
    const rawBefore=text.slice(Math.max(0,start-80),start);
    const previous=(rawBefore.split(/\d+(?:\.\d+)?/u).at(-1)??"")
      // Arabic و is a conjunction when separated as its own word; never
      // split embedded letters in a longer Arabic word.
      .split(/\b(?:and|or|but|plus|y|e|pero)\b|\s+و(?=\s|[$€£]|\d)|[;,.،!؟]/iu).at(-1)??"";
    const after=text.slice(end,end+65).split(/(?:\b(?:and|but|then|y|pero)\b|[;,.،!?؟]|\b\d+(?:\.\d+)?\b)/iu)[0]??"";
    // Never convert an owner-quoted non-USD amount into dollars.
    // USD is the ONLY canonical money unit. Reject explicit foreign dollar
    // qualifiers as well as euros and pounds; never silently convert them.
    // Scope these checks to this quoted number, not another clause's amount.
    const foreignDollarPrefix=/(?:^|[^\\p{L}])(?:ca|c|cad|a|au|aud|nz|nzd|sg|sgd|hk|hkd)\\s*\\$\\s*$/iu;
    const foreignDollarWord=/(?:\\b(?:canadian|australian|new\\s+zealand|singapore|hong\\s+kong)\\s+dollars?\\b|\\b(?:cad|aud|nzd|sgd|hkd)\\b|\\bd[oó]lares?\\s+(?:canadienses?|australianos?|neozelandeses?)\\b)/iu;
    if(/[€£]\\s*$/u.test(previous)||foreignDollarPrefix.test(previous)||
      /^\\s*(?:[€£]|euros?|pounds?|libras?|يورو|جنيه)/iu.test(after)||
      foreignDollarWord.test(previous)||foreignDollarWord.test(after))return false;
    const phrase=(previous+" "+after).toLocaleLowerCase();
    const dimensions=new Set<string>();
    if(/(?:\b(?:per|por|each|every|لكل)\s*(?:paid\s*)?(?:hours?|hrs?|horas?|hora)\b|\bhourly\b|بالساعة|لكل\s*ساعة)/iu.test(phrase))
      dimensions.add("USD_cents_per_hour");
    if(/(?:\b(?:per|por|each|every)\s*(?:items?|units?|products?|drinks?|cups?|lattes?|coffees?|bebidas?|tazas?)\b|لكل\s*(?:كوب|مشروب|وحدة))/iu.test(phrase))
      dimensions.add("USD_cents_per_item");
    if(/(?:\b(?:per|por)\s*(?:us\s*)?(?:gallons?|galones?)\b|لكل\s*غالون)/iu.test(phrase))
      dimensions.add("USD_cents_per_US_gallon");
    if(/(?:\b(?:per|por)\s*(?:fluid\s*)?(?:ounces?|oz|onzas?)\b|لكل\s*أونصة)/iu.test(phrase))
      dimensions.add("USD_cents_per_US_fl_oz");
    const observed=dimensions.size===0?"USD_cents":
      dimensions.size===1?[...dimensions][0]:null;
    resolved.push(observed===unit);
  }
  return resolved.length>0&&resolved.every(Boolean);
}
