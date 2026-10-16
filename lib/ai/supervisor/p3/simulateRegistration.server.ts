import "server-only";
import { z } from "zod";
import { schemaFingerprint,type SimulateRegistration } from
  "@/lib/ai/supervisor/p2/registry";
import {
  EXPRESSION_ID,planSchema,unit,bindingSchema,operandSchema,evaluateExpression,
  type TrustedContext,
} from "./expression";

/** Six-mode P2 registry's concrete P3 simulation, not an independent executor.
 * Source operands MUST already be read, validated and bound to selected café.
 */
const common={
  capabilityId:z.literal(EXPRESSION_ID),version:z.literal(1),
  mode:z.literal("simulate"),proposal:z.null(),executedEffects:z.literal(0),
};
const trace=z.array(z.string().min(1).max(200)).max(30);
const assumptions=z.array(z.string().max(300)).max(30);
const sources=z.array(z.string().min(1).max(120)).max(12);
const missing=z.array(z.string().max(300)).max(30);
const zero=z.array(z.never()).length(0);
const successful={
  ...common,value:z.number().finite().safe(),unit,
  currency:z.literal("USD").nullable(),
  formula:trace,assumptions,sourceHandles:sources,
};
export const simulationOutputSchema=z.discriminatedUnion("status",[
  z.strictObject({...successful,status:z.literal("conditional"),
    missingInputs:zero,reason:z.null()}),
  z.strictObject({...successful,status:z.literal("partial"),
    missingInputs:missing.min(1),reason:z.string().min(1).max(200)}),
  z.strictObject({...common,status:z.literal("unavailable"),
    value:z.null(),unit:z.null(),currency:z.null(),formula:zero,
    assumptions:zero,sourceHandles:zero,missingInputs:zero,
    reason:z.string().min(1).max(200)}),
]);

const trustedContextSchema=z.strictObject({
  businessId:z.string().min(1).max(120),
  locationId:z.string().min(1).max(120).nullable(),
  ownerMessage:z.string().min(3).max(4000),
  currency:z.literal("USD"),
  bindings:z.array(bindingSchema).max(100),
  operands:z.array(operandSchema).max(12),
});
export function registerExpressionSimulation():SimulateRegistration {
  const id=EXPRESSION_ID;
  return {
    id,version:1,mode:"simulate",availability:"shadow",
    owner:"platform",purpose:"Evaluate vetted expression using only authorized source operands.",
    sourceIds:["preauthorized_operands","no_external_sources"],
    canonicalReaderIds:[EXPRESSION_ID],
    allowedPurposes:["preauthorized_operands","no_external_sources"],
    inputSchema:planSchema,outputSchema:simulationOutputSchema,
    schemaContract:{id:id+".v1",registrationId:id,version:1,
      inputSchemaFingerprint:schemaFingerprint(planSchema),
      outputSchemaFingerprint:schemaFingerprint(simulationOutputSchema)},
    requiredRole:"owner",sensitivity:"financial",
    budgets:{maxOperations:1,timeoutMs:1000,maxResultBytes:10000,
      maxInputBytes:10000,maxRangeDays:365},
    requiresApproval:false,effectPolicy:"deny",
    simulate(scope,plan,rawContext){
      const parsed=trustedContextSchema.safeParse(rawContext);
      if(!parsed.success||parsed.data.businessId!==scope.businessId||
        parsed.data.operands.some(o=>o.asOf!==scope.identity.asOf ||
          (o.period!==null && o.period.timezone!==scope.identity.timezone)))
        return {status:"unavailable",capabilityId:EXPRESSION_ID,version:1,
          mode:"simulate",proposal:null,value:null,unit:null,currency:null,
          formula:[],assumptions:[],sourceHandles:[],missingInputs:[],
          reason:"invalid_source_context",executedEffects:0};
      // A pure calculation; never reaches scope.tools, DB, POS or mutations.
      return evaluateExpression(plan,parsed.data as TrustedContext);
    },
  };
}
