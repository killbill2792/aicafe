import "server-only";
import { alexNamedSimulateInputSchema, resolveAlexIngredientNames, type AlexNamedSimulateInput } from "./alexNamedInputs";
import { formatInTimeZone } from "date-fns-tz";
import { readAuthorizedAtomicP1SourceSnapshot } from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { schemaFingerprint, type ReadRegistration, type SimulateRegistration,
  type TrustedReadScope } from "@/lib/ai/supervisor/p2/registry";
import { type AlexReviewInput,alexReviewInputSchema,alexReviewOutputSchema,
  alexSimulateOutputSchema,reviewFromAtomicSnapshot,simulateFromAtomicSnapshot } from "./alexPricing";

/** New domain-owned IDs: the existing shadow alex.pricing.review.v1 is not
 * replaced or duplicated here. Central P2/P3 activation belongs to Kill Bill 1.
 */
export const ALEX_REVIEW_ID="alex.pricing.batch_review.v1";
export const ALEX_SIMULATE_ID="alex.pricing.what_if.v1";
const readPurpose="pricing_review";
const simulatePurpose="pricing_simulate";
const source=["p1.authoritative_snapshot.v1"];
const reader=["alex.pricing.atomic_snapshot"];
const limits={maxOperations:1,timeoutMs:10000,maxResultBytes:100000,
  maxInputBytes:10000,maxRangeDays:365} as const;
const base={
  version:1 as const,owner:"alex",sourceIds:source,
  canonicalReaderIds:reader,requiredRole:"owner" as const,
  sensitivity:"financial" as const,requiresApproval:false as const,
  effectPolicy:"deny" as const,budgets:limits,
};

/** Always use session-bound identity, not any model or caller-chosen tenant,
 * currency, revision, clock, employee or supplier authority. Both reads are
 * independently authorized atomic SQL observations and are NEVER combined.
 * An intervening mutation changes the source epoch => no result is published.
 */
async function withConsistentSnapshot<T>(
  scope:TrustedReadScope,run:(snapshot:NonNullable<
    Extract<Awaited<ReturnType<typeof readAuthorizedAtomicP1SourceSnapshot>>,
      {status:"available"}>["snapshot"]>,day:string)=>T,
):Promise<{status:"ok";value:T}|{status:"denied";reason:string}> {
  if(scope.role!=="owner"||!scope.shadowEnabled||
    scope.businessId!==scope.identity.businessId||!scope.businessId||
    scope.identity.currency!=="USD")
    return {status:"denied",reason:"unauthorized_or_unsupported_currency"};
  const first=await readAuthorizedAtomicP1SourceSnapshot();
  if(first.status!=="available")return {status:"denied",reason:first.reason};
  const snapshot=first.snapshot;
  if(snapshot.businessId!==scope.businessId||snapshot.currency!=="USD"||
    snapshot.timezone!==scope.identity.timezone)
    return {status:"denied",reason:"source_scope_mismatch"};
  // readSupervisorCafeIdentity supplies a café-local YYYY-MM-DD. Do not
  // round-trip this through UTC midnight: that shifts western cafés back a day
  // and silently excludes prices effective on the actual business date.
  const asOf=scope.identity.asOf;
  let day:string;
  if(/^\d{4}-\d{2}-\d{2}$/.test(asOf)){
    const normalized=new Date(asOf+"T12:00:00Z");
    if(!Number.isFinite(normalized.getTime())||
      normalized.toISOString().slice(0,10)!==asOf)
      return {status:"denied",reason:"invalid_trusted_clock"};
    day=asOf;
  }else{
    // Preserve explicit timestamp support in domain tests / future callers;
    // reject ambiguous local timestamps without a UTC offset.
    if(!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf))
      return {status:"denied",reason:"invalid_trusted_clock"};
    const now=new Date(asOf);
    if(!Number.isFinite(now.getTime()))
      return {status:"denied",reason:"invalid_trusted_clock"};
    day=formatInTimeZone(now,snapshot.timezone,"yyyy-MM-dd");
  }
  const value=run(snapshot,day);
  const second=await readAuthorizedAtomicP1SourceSnapshot();
  if(second.status!=="available"||second.snapshot.businessId!==snapshot.businessId||
    second.snapshot.revision!==snapshot.revision ||
    second.snapshot.timezone!==snapshot.timezone||
    second.snapshot.currency!==snapshot.currency)
    return {status:"denied",reason:"source_revision_changed_or_unavailable"};
  return {status:"ok",value};
}

export function buildAlexPricingRegistrations():readonly [ReadRegistration,SimulateRegistration]{
  return [
    {
      ...base,id:ALEX_REVIEW_ID,mode:"read" as const,availability:"shadow" as const,
      purpose:"Batch review exact canonical menu variants, current ingredient-only cost, ratios and missing evidence. Requires a product ID, exact unambiguous name or bounded active-menu page.",
      allowedPurposes:[readPurpose],
      inputSchema:alexReviewInputSchema,outputSchema:alexReviewOutputSchema,
      schemaContract:{id:ALEX_REVIEW_ID+".v1",registrationId:ALEX_REVIEW_ID,
        version:1 as const,inputSchemaFingerprint:schemaFingerprint(alexReviewInputSchema),
        outputSchemaFingerprint:schemaFingerprint(alexReviewOutputSchema)},
      async read(scope,input){
        const result=await withConsistentSnapshot(scope,(snapshot,day)=>
          reviewFromAtomicSnapshot(snapshot,input as AlexReviewInput,day));
        if(result.status==="denied")return {status:result.reason==="source_revision_changed_or_unavailable"?
          "conflict":"unavailable",value:null,reason:result.reason};
        return result.value;
      },
    },
    {
      ...base,id:ALEX_SIMULATE_ID,mode:"simulate" as const,availability:"shadow" as const,
      purpose:"Pure price and recipe quantity, ingredient substitution, supplier package-cost and ingredient-unit cost what-ifs using canonical menu/recipe evidence; owner-defined cost targets only. Never writes.",
      allowedPurposes:[simulatePurpose],
      inputSchema:alexNamedSimulateInputSchema,outputSchema:alexSimulateOutputSchema,
      schemaContract:{id:ALEX_SIMULATE_ID+".v1",registrationId:ALEX_SIMULATE_ID,
        version:1 as const,inputSchemaFingerprint:schemaFingerprint(alexNamedSimulateInputSchema),
        outputSchemaFingerprint:schemaFingerprint(alexSimulateOutputSchema)},
      async simulate(scope,input){
        // Registry enforces preauthorized binding envelope; this domain NEVER
        // trusts an externally supplied snapshot, price, tenant or revision.
        const result=await withConsistentSnapshot(scope,(snapshot,day)=>
          {
            const resolved=resolveAlexIngredientNames(snapshot,input as AlexNamedSimulateInput);
            return resolved.ok?simulateFromAtomicSnapshot(snapshot,resolved.input,day):
              {status:"unavailable" as const,mode:"simulate" as const,proposal:null,executedEffects:0 as const,
                value:null,reason:resolved.reason};
          });
        if(result.status==="denied")return {status:"unavailable",mode:"simulate",
          proposal:null,executedEffects:0,value:null,reason:result.reason};
        return result.value;
      },
    },
  ];
}
