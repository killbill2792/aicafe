import {parseOwnerDecimal} from "@/lib/calc/localeDecimal";
type Locale="en"|"es"|"ar";
/** Strict grouping-aware owner inputs, without changing Prompt B's shared math. */
export function parseOwnerFactDecimal(raw:string,locale:Locale):number|null{
 let text=raw.trim();
 if(locale==="en"&&/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text))
   text=text.replace(/,/g,"");
 if(locale==="es"&&/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text))
   text=text.replace(/\./g,"");
 return parseOwnerDecimal(text,locale);
}
