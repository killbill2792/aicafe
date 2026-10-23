/** Showing known cost never silently turns unknown rates into a $0 total. */
export function displayKnownCost(known:number,priced:number,turns:number):string{
  if(priced===0)return turns===0?"No turns":"Not priced";
  const usd=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:4,maximumFractionDigits:6}).format(known);
  const unpriced=turns-priced;
  return unpriced>0?`${usd} known · ${unpriced.toLocaleString("en-US")} unpriced`:usd;
}
export function displayAverageCost(amount:number|null,priced:number,turns:number):string{
  if(amount===null||priced===0)return "Not priced";
  const result=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:4,maximumFractionDigits:6}).format(amount);
  return priced<turns?`${result} (priced only)`:result;
}
