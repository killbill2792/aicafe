/** Locale-aware decimal input, rejecting grouping ambiguity and non-finite values.
 * Supports ASCII, Arabic-Indic and Eastern Arabic digits; Spanish decimal commas.
 */
export function parseOwnerDecimal(raw:string,locale:"en"|"es"|"ar"):number|null{
 const normalized=raw.trim().replace(/[٠-٩۰-۹]/g,ch=>{
  const code=ch.charCodeAt(0);
  return String(code>=0x6F0?code-0x6F0:code-0x660);
 }).replace(/٫/g,".").replace(/٬/g,"").replace(/[\u00a0\u202f\s]/g,"");
 if(!normalized)return null;
 const decimal=locale==="es"?normalized.replace(",","."):normalized;
 if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal))return null;
 const value=Number(decimal);
 return Number.isFinite(value)&&value>=0?value:null;
}
