import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { inputFor, ownerFor, purposePolicies, readers, sourcePolicies, values,
  type SupportedId } from "./p1Catalog";
import { authorizedOwnerP1, executeP1Authorized, outputFor } from "./p1Readers.server";

/**
 * P1 ANALYSES ARE READS. This does not introduce the six-mode P2 registry,
 * model routing, simulations, mutations, proposals or an action executor.
 * These literal keys bind to existing real typed P1 read contracts.
 */
function compileRead<K extends SupportedId>(key:K) {
  const inputSchema=inputFor(key);
  const outputSchema=outputFor(key);
  return Object.freeze({key,version:1 as const,mode:"read" as const,
    inputSchema,outputSchema,
    schemaContractId:key+".read.v1",schemaContractVersion:1 as const});
}
export const p1ReadCapabilities = Object.freeze({
  "pricing.recommendation":compileRead("pricing.recommendation"),
  "supplies.quotes":compileRead("supplies.quotes"),
  "money.business_costs":compileRead("money.business_costs"),
  "labor.availability_foundation":compileRead("labor.availability_foundation"),
});
type ReadKey=keyof typeof p1ReadCapabilities;
type Purpose<K extends ReadKey>=(typeof purposePolicies)[K][number];

function fingerprint(schema:z.ZodType) {
  // This fingerprint checks the exact serializable Zod JSON-schema contract.
  // The separate revision and semantic regression tests cover refine semantics.
  const json=z.toJSONSchema(schema,{unrepresentable:"any",reused:"inline"});
  return createHash("sha256").update(JSON.stringify(json)).digest("hex");
}
function defineReadAnalysis<const K extends ReadKey>(id:string,key:K) {
  const capability=p1ReadCapabilities[key];
  const purposes=purposePolicies[key];
  const sourceRequirementsByPurpose=Object.fromEntries(purposes.map(p=>[p,{
    kind:"registered_sources" as const,
    inputs:[{metricIds:[] as string[],entityReadIds:[key],
      readerId:readers[key],readerVersion:1,
      selectorId:sourcePolicies[key][p].selectorContractId,
      selectorVersion:sourcePolicies[key][p].selectorContractVersion,
      precedencePolicyId:sourcePolicies[key][p].precedencePolicyId,
      precedencePolicyRevision:sourcePolicies[key][p].precedencePolicyRevision,
      sourcePurpose:p,minimumCoverage:"partial_explicit" as const,
      allowedActualities:["actual","estimated","planned","unknown"] as const,
    }],
    minimumOverallCoverage:"partial_explicit" as const,
  }])) as Record<Purpose<K>,{
    kind:"registered_sources";inputs:[{
      metricIds:string[];entityReadIds:string[];readerId:string;readerVersion:number;
      selectorId:string;selectorVersion:number;precedencePolicyId:string;
      precedencePolicyRevision:number;sourcePurpose:string;minimumCoverage:"partial_explicit";
      allowedActualities:readonly ["actual","estimated","planned","unknown"];
    }];minimumOverallCoverage:"partial_explicit";
  }>;
  const invocationSchema=z.strictObject({
    analysisId:z.literal(id),analysisVersion:z.literal(1),
    boundCapabilityKey:z.literal(key),
    selectedPurpose:z.enum(purposes as unknown as [Purpose<K>,...Purpose<K>[]]),
    input:capability.inputSchema,
  }).superRefine((v,ctx)=>{
    if(v.selectedPurpose!==(v.input as {purpose:string}).purpose)
      ctx.addIssue({code:"custom",message:"Analysis and bound read purposes differ"});
  });
  const schemaContract=Object.freeze({
    id:capability.schemaContractId,version:capability.schemaContractVersion,
    inputSchemaFingerprint:fingerprint(capability.inputSchema),
    outputSchemaFingerprint:fingerprint(capability.outputSchema),
  });
  return Object.freeze({
    kind:"analysis" as const,id,version:1 as const,domainOwner:ownerFor(key),
    boundCapabilityKey:key,boundCapabilityVersion:1 as const,boundCapabilityMode:"read" as const,
    schemaContract,inputSchema:capability.inputSchema,
    outputSchema:capability.outputSchema,invocationSchema,
    allowedPurposes:purposes,
    sourceRequirementsByPurpose,
    authorization:Object.freeze({
      requiredRole:"owner" as const,scope:"business" as const,
      sensitivity:key.startsWith("money.")?"financial" as const:
        key.startsWith("labor.")?"staff" as const:"normal" as const,
    }),
    resourceLimits:Object.freeze({maxRangeDays:365,maxRows:500,maxSourceRefs:20,
      maxSeriesPoints:366,maxOperations:1,timeoutMs:10000,maxResultBytes:100000}),
    requiresContextVersion:1 as const,
  });
}

/** New specialists add a read registration here, not router branches.
 * Olivia's optimizer is intentionally NOT registered: #75/P5 remain separate.
 */
export const p1Analyses=Object.freeze({
  "alex.pricing.review.v1":defineReadAnalysis("alex.pricing.review.v1","pricing.recommendation"),
  "maya.supplies.quote_evidence.v1":defineReadAnalysis("maya.supplies.quote_evidence.v1","supplies.quotes"),
  "leo.money.costs.v1":defineReadAnalysis("leo.money.costs.v1","money.business_costs"),
  "olivia.availability.foundation.v1":defineReadAnalysis("olivia.availability.foundation.v1","labor.availability_foundation"),
});
export type P1AnalysisId=keyof typeof p1Analyses;

const denied=(reason:"unknown_analysis"|"invalid_analysis_invocation"|"invalid_analysis_contract"|"unauthorized")=>
  ({status:"unavailable" as const,value:null,reason});

/**
 * Both-way runtime contract check. Fail if a catalog entry, version, schema
 * binding, selected purpose or source policy disappears or is repointed.
 * Never invoke a model-selected arbitrary function/key.
 */
export function validateP1Analyses() {
  const definitions=Object.values(p1Analyses);
  if(definitions.length!==Object.keys(p1ReadCapabilities).length) return false;
  if(new Set(definitions.map(x=>x.id)).size!==definitions.length) return false;
  if(new Set(definitions.map(x=>x.boundCapabilityKey)).size!==definitions.length)return false;
  return definitions.every(def=>{
    const key=def.boundCapabilityKey;
    const cap=p1ReadCapabilities[key];
    if(!cap||cap.mode!=="read"||cap.version!==def.boundCapabilityVersion||
      def.boundCapabilityMode!=="read"||!(key in values)||
      def.inputSchema!==cap.inputSchema||def.outputSchema!==cap.outputSchema||
      def.schemaContract.id!==cap.schemaContractId||
      def.schemaContract.version!==cap.schemaContractVersion||
      def.schemaContract.inputSchemaFingerprint!==fingerprint(cap.inputSchema)||
      def.schemaContract.outputSchemaFingerprint!==fingerprint(cap.outputSchema)||
      !def.allowedPurposes.length||
      new Set(def.allowedPurposes).size!==def.allowedPurposes.length||
      Object.keys(def.sourceRequirementsByPurpose).length!==def.allowedPurposes.length)
      return false;
    return def.allowedPurposes.every(p=>{
      if(!Object.hasOwn(def.sourceRequirementsByPurpose,p))return false;
      const selection=def.sourceRequirementsByPurpose[p];
      const required=sourcePolicies[key][p];
      return !!required && selection.kind==="registered_sources" &&
        selection.minimumOverallCoverage==="partial_explicit" &&
        selection.inputs.length===1 && selection.inputs[0].readerId===readers[key] &&
        selection.inputs[0].sourcePurpose===p &&
        selection.inputs[0].selectorId===required.selectorContractId &&
        selection.inputs[0].selectorVersion===required.selectorContractVersion &&
        selection.inputs[0].precedencePolicyId===required.precedencePolicyId &&
        selection.inputs[0].precedencePolicyRevision===required.precedencePolicyRevision &&
        selection.inputs[0].entityReadIds.length===1 &&
        selection.inputs[0].entityReadIds[0]===key;
    });
  });
}

/** This is a bounded read-only analysis invocation, not P2 orchestration. */
export async function executeP1AnalysisAuthorized(
  tools:BusinessScopedCafeTools,
  identity:{businessId?:string;asOf:string;timezone:string},
  raw:unknown,
) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return denied("invalid_analysis_invocation");
  const id=(raw as {analysisId?:unknown}).analysisId;
  if(typeof id!=="string" || !Object.hasOwn(p1Analyses,id))return denied("unknown_analysis");
  const def=p1Analyses[id as P1AnalysisId];
  if(!validateP1Analyses())return denied("invalid_analysis_contract");
  const parsed=def.invocationSchema.safeParse(raw);
  if(!parsed.success)return denied("invalid_analysis_invocation");
  // Clone the strict parsed typed invocation to prevent mutable caller objects
  // selecting a second purpose between the schema and actual read.
  const frozen=Object.freeze(structuredClone(parsed.data));
  if(frozen.boundCapabilityKey!==def.boundCapabilityKey ||
    frozen.selectedPurpose!==(frozen.input as {purpose:string}).purpose)
    return denied("invalid_analysis_invocation");
  const result=await executeP1Authorized(tools,identity,frozen.input);
  // The bound capability owns the complete output schema and its safety gates.
  return def.outputSchema.safeParse(result).success?result:denied("invalid_analysis_contract");
}
export async function analyzeAuthenticatedP1(raw:unknown) {
  try {
    const {tools,identity}=await authorizedOwnerP1();
    return executeP1AnalysisAuthorized(tools,identity,raw);
  }catch{return denied("unauthorized");}
}
export function discoverP1Analyses() {
  if(!validateP1Analyses())throw new Error("P1 analysis registry contract failure");
  return Object.values(p1Analyses).map(def=>({
    id:def.id,version:def.version,kind:def.kind,owner:def.domainOwner,
    boundCapabilityKey:def.boundCapabilityKey,boundCapabilityMode:def.boundCapabilityMode,
    schemaContract:def.schemaContract,
    allowedPurposes:def.allowedPurposes,
    authorization:def.authorization,
    resourceLimits:def.resourceLimits,
  }));
}
export async function discoverAuthenticatedP1Analyses() {
  await authorizedOwnerP1();
  return discoverP1Analyses();
}
