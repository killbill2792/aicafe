/** Presentation only. All stored and verified monetary values remain integer cents. */
export type EventReportLocale="en"|"es"|"ar";
export function formatEventMoney(cents:number|null,currency:string|null,
  locale:EventReportLocale):string|null{
  if(cents===null||!Number.isSafeInteger(cents))return null;
  const majorUnits=cents/100;
  return currency
    ?new Intl.NumberFormat(locale,{style:"currency",currency}).format(majorUnits)
    :new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(majorUnits);
}
