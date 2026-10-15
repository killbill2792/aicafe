import "server-only";
import {
  executeP1AnalysisAuthorized, p1Analyses, validateP1Analyses,
} from "@/lib/metrics/p1Analyses.server";
import type { ReadRegistration } from "./registry";

/** Owner-facing purposes belong to the capability, not a Supervisor keyword router.
 * Adding a fifth registered domain does not modify orchestration or the model schema.
 */
const purposes = {
  "alex.pricing.review.v1":
    "Review the canonical current price, recipe cost and price recommendation for a known menu product ID. Requires productId; missing ingredient prices remain unavailable.",
  "maya.supplies.quote_evidence.v1":
    "Inspect owner-recorded supplier price quotations, with provenance. A quote is not an inventory count, purchase or delivery.",
  "leo.money.costs.v1":
    "Review actual versus missing or estimated café operating expenses for a dated period. Includes ingredient, labor and operating cost evidence, not an automatically complete profit.",
  "olivia.availability.foundation.v1":
    "Inspect the activated manual employee availability and coverage foundation. Does not optimize or publish schedules or infer worker acceptance.",
} as const satisfies Record<keyof typeof p1Analyses,string>;

export function buildP1P2Registrations():readonly ReadRegistration[] {
  if(!validateP1Analyses())throw new Error("P1 schema/reader/source contracts invalid");
  return Object.values(p1Analyses).map(def=>({
    id:def.id,version:1 as const,mode:"read" as const,availability:"shadow" as const,
    owner:def.domainOwner,purpose:purposes[def.id as keyof typeof purposes],
    sourceIds:(Object.values(def.sourceRequirementsByPurpose)[0] as {
      inputs:Array<{metricIds:string[];entityReadIds:string[]}>;
    }).inputs.flatMap(source=>[...source.metricIds,...source.entityReadIds]),
    allowedPurposes:def.allowedPurposes,
    inputSchema:def.inputSchema,outputSchema:def.outputSchema,
    schemaContract:{...def.schemaContract,registrationId:def.id},
    requiredRole:"owner" as const,sensitivity:def.authorization.sensitivity,
    budgets:{
      maxOperations:1,timeoutMs:10000,maxResultBytes:100000,maxInputBytes:10000,
      maxRangeDays:365,
    },
    requiresApproval:false as const,effectPolicy:"deny" as const,
    async read(scope, rawInput) {
      // The P1 analysis wrapper uses a pre-authorized business-scoped reader.
      // Its P1 method does not propagate currency to the nested reader. Until
      // that is corrected in P1, reject ALL non-USD monetary domains here.
      if(scope.identity.currency!=="USD" && def.id!=="olivia.availability.foundation.v1")
        return {status:"unavailable",value:null,reason:"unsupported"};
      const input=rawInput as {purpose:string};
      return executeP1AnalysisAuthorized(scope.tools,scope.identity,{
        analysisId:def.id,analysisVersion:1,boundCapabilityKey:def.boundCapabilityKey,
        selectedPurpose:input.purpose,input:rawInput,
      });
    },
  }));
}
