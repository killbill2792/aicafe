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
const items=/\b(?:items?|units?|products?|drinks?|cups?|lattes?|coffees?|beverages?|bebidas?|tazas?|unidades?|productos?)\b|أكواب|كوب|مشروبات|وحدات/iu;
const word=/[\p{L}\p{N}]/u;
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
    hits.push(found);
  }
  const expected=unit.startsWith("USD_")?"money":unit;
  return hits.some(x=>x.size===1&&x.has(expected))&&
    hits.every(x=>x.size===0||(x.size===1&&x.has(expected)));
}
