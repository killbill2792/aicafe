/** Format stored integer cents using the authenticated café's ISO currency.
 * Missing/invalid currency is an explicit condition, never an implicit USD.
 */
export function formatCafeCurrency(cents:number,locale:string,currency:string|null|undefined){
 const valid=typeof currency==="string"&&/^[A-Z]{3}$/.test(currency);
 if(valid){
  try{return {text:new Intl.NumberFormat(locale,{style:"currency",currency}).format(cents/100),
   currencyMissing:false};}catch{ /* Unsupported ISO currency: display cents with caveat. */ }
 }
 return {text:new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100),
  currencyMissing:true};
}
