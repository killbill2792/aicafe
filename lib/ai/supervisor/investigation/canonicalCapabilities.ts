/** Model-visible canonical groups. P1 registrations and every original schema
 * stay intact for existing callers; only duplicate model-facing scalar reads
 * are hidden when their structured parent is discoverable.
 *
 * Every alias is a projection from the SAME registered reader. Do not infer
 * equivalence from names or aggregate unrelated periods, locations or costs.
 */
export const CANONICAL_ALIASES = {
  "p3.money.recurring_monthly_bills_cents.v1":{parent:"p3.money.monthly_bills.v1",field:"totalCents"},
  "p3.money.recorded_spending_cents.v1":{parent:"p3.money.recorded_spending.v1",field:"totalCents"},
  "p3.money.owner_profit_cents.v1":{parent:"p3.money.profitability.v1",field:"ownerProfitCents"},
  "p3.sales.net_sales_cents.v1":{parent:"p3.money.profitability.v1",field:"netSalesCents"},
  "p3.money.total_costs_cents.v1":{parent:"p3.money.profitability.v1",field:"totalCostsCents"},
  "p3.money.operating_margin_ratio.v1":{parent:"p3.money.profitability.v1",field:"operatingMargin"},
} as const;
export function modelVisibleIds(ids:readonly string[]):string[]{
  const all=new Set(ids);
  return ids.filter(id=>{
    const alias=CANONICAL_ALIASES[id as keyof typeof CANONICAL_ALIASES];
    return !alias||!all.has(alias.parent);
  });
}
/** Preserve machine-level input schema; this human summary adds fields and
 * semantics rather than a second independently-maintained schema. */
export function describeSourceFields(schema:unknown,maxLength=500):string{
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
  if(!object(schema))return "";
  const value=object(schema.properties)&&object(schema.properties.value)?schema.properties.value:schema;
  const props=object(value.properties)?value.properties:null;
  if(!props)return "Value contract: "+JSON.stringify(value).slice(0,maxLength);
  const fields=Object.entries(props).map(([key,v])=>{
    const field=object(v)?v:{};
    const type=typeof field.type==="string"?field.type:field.anyOf?"optional":"typed";
    return key+":"+type+(key.endsWith("Cents")?" (USD cents)":"");
  });
  return "Returns fields: "+fields.join(", ").slice(0,maxLength)+".";
}
