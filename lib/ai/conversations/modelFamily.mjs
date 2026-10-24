/** Normalize dated provider model IDs without pretending unknown models are priced. */
export function modelFamily(id) {
  const model=typeof id==="string"?id.trim().toLowerCase():"";
  const known=["gpt-6-luna","gpt-6-sol","gpt-6-astra"];
  return known.find(family=>model===family||new RegExp("^"+family+"-\\d{4}-\\d{2}-\\d{2}$").test(model))??null;
}
