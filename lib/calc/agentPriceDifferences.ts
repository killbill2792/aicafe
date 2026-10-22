/** Pure cents arithmetic for a claim that explicitly names two menu products.
 * The caller must validate product identity, comparator and provenance. */
export function menuPriceDifferenceCents(leftCents:number,rightCents:number,
  direction:"more"|"less"):number|null {
  if(!Number.isSafeInteger(leftCents)||!Number.isSafeInteger(rightCents))return null;
  const difference=direction==="more"?leftCents-rightCents:rightCents-leftCents;
  return Number.isSafeInteger(difference)&&difference>=0?difference:null;
}
