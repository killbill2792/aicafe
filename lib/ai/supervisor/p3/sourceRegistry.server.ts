import "server-only";
import {z} from "zod";
import { createP2Registry,schemaFingerprint,unavailable,type ReadRegistration,
  type TrustedReadScope, type SimulateRegistration } from "@/lib/ai/supervisor/p2/registry";
import { executeP1Authorized,outputFor } from "@/lib/metrics/p1Readers.server";
import { registerExpressionSimulation } from "./simulateRegistration.server";
import { inputFor,purposePolicies,readers,sourcePolicies,values,
  currencyIndependentP1Ids,type SupportedId } from "@/lib/metrics/p1Catalog";

/** The registered output schema, not a second prompt-only list, supplies
 * compact field discovery. All original typed parameters remain unchanged. */
export function describeP1Source(key:SupportedId):string {
  const shape=z.toJSONSchema(values[key],{unrepresentable:"any",reused:"inline"}) as Record<string,unknown>;
  const item=shape.type==="array"&&shape.items&&typeof shape.items==="object"
    ?shape.items as Record<string,unknown>:shape;
  const fields=item.properties&&typeof item.properties==="object"
    ?Object.keys(item.properties as Record<string,unknown>):[];
  const related=(Object.keys(readers) as SupportedId[]).filter(k=>k!==key&&readers[k]===readers[key]);
  const relationships=related.length?
    " Shares a canonical reader with "+related.join(", ")+"; these are different projections, not separate transactions.":"";
  return (sourceDescriptions[key]??"Read authorized "+key+" business records.")+
    " Output "+(shape.type==="array"?"array":"record")+
    " fields: "+(fields.length?fields.join(", "):shape.type==="number"?"numeric scalar":"typed value")+
    ". Fields ending in Cents are integer cents, never dollars."+
    relationships;
}
const sourceDescriptions:Partial<Record<SupportedId,string>>={
  "money.monthly_bills":"Recorded recurring bills normalized monthly; not proof of paid bills or total business operating costs.",
  "money.recurring_monthly_bills_cents":"Numeric alias of money.monthly_bills.totalCents; do not read both.",
  "money.profitability":"Period financial summary: net sales, costs, profit, margin, sales-day coverage.",
  "money.recorded_spending":"Recorded actual expense total for a period; distinct from planned recurring bills.",
  "money.recurring_bill_rows":"Individual recurring bill rows (a breakdown), not a second monthly total.",
  "menu.catalog":"Menu products, active flags and recorded prices; NOT item units sold.",
  "sales.item_units":"Product units actually sold for a selected period; coverage must be assessed separately.",
  "sales.daily":"Daily sales summaries; NOT hourly transactions.",
};
/** Hide only aliases whose structured canonical reader has a fully tested
 * cents operand adapter. Old aliases remain registered and callable. */
export function isRedundantModelRead(id:string):boolean{
  return id==="p3.money.recurring_monthly_bills_cents.v1";
}
/**
 * Each P1 canonical key is a discovered registration. New P1 domains require
 * no edits to the orchestration/router. Each source is still authorized by
 * P1, with strict input/result schemas and independently pinned reader identity.
 */
export function buildP3P1Registrations():readonly ReadRegistration[] {
  return (Object.keys(values) as SupportedId[]).map(key=>{
    const inputSchema=inputFor(key),outputSchema=outputFor(key);
    const purposes=purposePolicies[key] as readonly string[];
    if(!purposes.length||purposes.some(p=>
      sourcePolicies[key]?.[p]?.canonicalReaderId!==readers[key]||
      sourcePolicies[key]?.[p]?.readerContractVersion!==1||
      sourcePolicies[key]?.[p]?.selectorContractVersion!==1))
      throw new Error("P3 unregistered source policy: "+key);
    const id="p3."+key+".v1";
    return {
      id,version:1 as const,mode:"read" as const,availability:"shadow" as const,
      owner:key.split(".")[0],purpose:describeP1Source(key),
      sourceIds:[key],canonicalReaderIds:[readers[key]],allowedPurposes:purposes,
      inputSchema,outputSchema,currencyPolicy:currencyIndependentP1Ids.has(key)?"independent" as const:"USD_only" as const,
      schemaContract:{id:id+".v1",registrationId:id,version:1 as const,
        inputSchemaFingerprint:schemaFingerprint(inputSchema),
        outputSchemaFingerprint:schemaFingerprint(outputSchema)},
      requiredRole:"owner" as const,
      sensitivity:key.startsWith("labor.")?"staff" as const:
        key.startsWith("money.")||key.startsWith("sales.")?"financial" as const:"normal" as const,
      budgets:{maxOperations:1,timeoutMs:10000,maxResultBytes:100000,
        maxInputBytes:10000,maxRangeDays:365},
      requiresApproval:false as const,effectPolicy:"deny" as const,
      async read(scope:TrustedReadScope,rawInput:unknown){
        // P1's business/membership-checked reader is still the sole source.
        // P1's monetary outputs currently assume USD; fail closed in any other currency.
        if(scope.identity.currency!=="USD" && !currencyIndependentP1Ids.has(key))
          return unavailable("unsupported");
        return executeP1Authorized(scope.tools,scope.identity,rawInput);
      },
    };
  });
}
/** Domain modules own their descriptors and handlers. Shared P3 wiring only
 * accepts statically imported, reviewed read/simulate registrations; never
 * model-provided registration, effect mode, or independent specialist chat.
 * Olivia and Alex are added here only AFTER their own PRs are merged.
 */
export type P3DomainRegistrations = readonly (ReadRegistration | SimulateRegistration)[];
export const createP3ReadRegistry=(domains:P3DomainRegistrations=[])=>createP2Registry([
  ...buildP3P1Registrations(),registerExpressionSimulation(),...domains,
]);
