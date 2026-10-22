/** Calendar-bounded periods, independent of the registry to prevent initialization cycles. */
export function requestedPeriod(choice:"today"|"week"|"month",asOf:string){
  const from=choice==="today"?asOf:choice==="month"?asOf.slice(0,7)+"-01":
    new Date(Date.parse(asOf+"T12:00:00Z")-6*86400000).toISOString().slice(0,10);
  return {from,to:asOf};
}
