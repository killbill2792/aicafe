/** Recognize only an explicit owner follow-up to exactly one earlier
 * owner-authored price scenario. This is intent routing, not model-generated
 * math, consent, or authority to perform a business write. */
export function normalizedDrinkName(value:string):string{
  return value.toLocaleLowerCase("en").normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu," ").trim();
}
export function priceExperimentFollowupIntent(current:string,previous:string):
  {product:string;increaseCents:number}|null{
  const go=current.trim();
  if(!/^(?:let['’]?s try it|let['’]?s test it|go ahead and try it|try that price|prob[eé]moslo|vamos a probarlo|لنجربه|لنجرّبه)[.!؟\s]*$/iu.test(
      go.replace(/\s+/gu," ").replace(/\s+$/u,"")))return null;
  const patterns=[
    /\b(?:raise|increase)\s+(?:the\s+)?([a-z][a-z0-9\s-]{0,90}?)\s+price\s+by\s+(\d{1,6})\s+cents?\b/giu,
    /\b(?:raise|increase)\s+(?:the\s+)?price\s+of\s+([a-z][a-z0-9\s-]{0,90}?)\s+by\s+(\d{1,6})\s+cents?\b/giu,
  ];
  const matches=patterns.flatMap(rx=>[...previous.matchAll(rx)]);
  if(matches.length!==1)return null;
  const product=matches[0][1]?.trim();
  const increaseCents=Number(matches[0][2]);
  if(!product||!Number.isSafeInteger(increaseCents)||increaseCents<1||
    increaseCents>100000)return null;
  return {product,increaseCents};
}
