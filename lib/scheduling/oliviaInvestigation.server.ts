import "server-only";
import {z} from "zod";
import {oliviaReadRequestSchema,oliviaReadResponseSchema} from "./oliviaCapabilityContracts";
import {matchesOwnerScheduleDates} from "./whatIfOwnerDates";
import {executeOliviaReadCapability} from "./oliviaCapabilities.server";
import {schemaFingerprint,type ReadRegistration} from "@/lib/ai/supervisor/p2/registry";
const inputSchema=z.strictObject({purpose:z.literal("scheduling_investigation"),request:oliviaReadRequestSchema});
const outputSchema=z.union([
  z.strictObject({status:z.literal("unavailable"),value:z.null(),reason:z.string().max(100)}),
  z.strictObject({status:z.literal("partial"),id:z.literal("olivia.records"),value:oliviaReadResponseSchema,
    provenance:z.strictObject({sourceId:z.literal("olivia.schedule_foundation"),canonicalReaderId:z.literal("olivia.authorized.read"),
      sourceRevision:z.null(),asOf:z.string(),purpose:z.literal("scheduling_investigation")}),
    quality:z.strictObject({missingInputs:z.array(z.string()),estimatedInputs:z.array(z.string()),staleInputs:z.array(z.string())})}),
]);
/** Full typed read contract: roster, availability, preview, saved history/revision,
 * and what-if details are available for iterative reasoning, not summary-only views. */
export function buildOliviaInvestigationRegistration():ReadRegistration{
  const id="p3.olivia.records.v1";
  return {id,version:1,owner:"olivia",mode:"read",availability:"shadow",
    purpose:"Inspect full authorized staff availability/roster, schedule preview, saved revision/history or what-if result. Resolve employee/revision IDs from these records before further reads. Never saves, approves or publishes. Prefer the named-worker what-if for natural names; this reader exposes full source details for investigation.",
    sourceIds:["olivia.schedule_foundation"],canonicalReaderIds:["olivia.authorized.read"],allowedPurposes:["scheduling_investigation"],
    inputSchema,outputSchema,schemaContract:{id:id+".v1",registrationId:id,version:1,
      inputSchemaFingerprint:schemaFingerprint(inputSchema),outputSchemaFingerprint:schemaFingerprint(outputSchema)},
    requiredRole:"owner",sensitivity:"staff",requiresApproval:false,effectPolicy:"deny",
    budgets:{maxOperations:1,timeoutMs:10000,maxInputBytes:10000,maxResultBytes:100000,maxRangeDays:7},
    async read(scope,raw){
      const input=inputSchema.parse(raw);
      if(scope.ownerClause&&"week" in input.request && !matchesOwnerScheduleDates({week:input.request.week,
        overrides:"overrides" in input.request?input.request.overrides:[]},scope.ownerClause,scope.identity.asOf))
        return {status:"unavailable",value:null,reason:"invalid_input"};
      const result=await executeOliviaReadCapability(input.request);
      if(!result.ok)return {status:"unavailable",value:null,reason:result.error.code};
      if(result.source.businessId!==scope.businessId)return {status:"unavailable",value:null,reason:"unauthorized"};
      return {status:"partial",id:"olivia.records",value:result,
        provenance:{sourceId:"olivia.schedule_foundation",canonicalReaderId:"olivia.authorized.read",sourceRevision:null,
          asOf:scope.identity.asOf,purpose:input.purpose},
        quality:{missingInputs:["scheduling_read_is_provisional"],estimatedInputs:[],staleInputs:[]}};
    }};
}
