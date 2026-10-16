import "server-only";
import { createP2Registry,schemaFingerprint,unavailable,type ReadRegistration,
  type TrustedReadScope } from "@/lib/ai/supervisor/p2/registry";
import { executeP1Authorized,outputFor } from "@/lib/metrics/p1Readers.server";
import { registerExpressionSimulation } from "./simulateRegistration.server";
import { inputFor,purposePolicies,readers,sourcePolicies,values,
  metricUnits,type SupportedId } from "@/lib/metrics/p1Catalog";

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
      owner:key.split(".")[0],purpose:"Authorized canonical "+key+" source read.",
      sourceIds:[key],canonicalReaderIds:[readers[key]],allowedPurposes:purposes,
      inputSchema,outputSchema,
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
        if(scope.identity.currency!=="USD" && key in metricUnits)
          return unavailable("unsupported");
        return executeP1Authorized(scope.tools,scope.identity,rawInput);
      },
    };
  });
}
export const createP3ReadRegistry=()=>createP2Registry([
  ...buildP3P1Registrations(),registerExpressionSimulation(),
]);
