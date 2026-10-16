import "server-only";

import { z } from "zod";
import { requireSchedulingOwner } from "./foundation.server";
import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
import {
  oliviaPrepareAvailabilitySchema, oliviaConfirmedCommitSchema,
  oliviaCreateDraftSchema, oliviaSavedDraftCommandResponseSchema,
} from "./oliviaCommandContracts";
import { oliviaProposalDigest, reconcileOliviaAvailability,
  oliviaCanonicalJson } from "./oliviaAvailabilityProposal";
import {
  consumeOliviaOwnerActionProof, type OliviaOwnerActionProof,
} from "./oliviaOwnerAction.server";
import { saveOliviaWeekDraft } from "@/lib/actions/oliviaPlanning";
import { foundationRecordSchemas } from "./foundationSchemas";

type Code="invalid_input"|"unauthorized"|"disabled"|"not_found"|
  "ambiguous_employee"|"inactive_employee"|"revision_conflict"|
  "source_changed"|"invalid_record"|"storage_unavailable"|"missing_inputs"|
  "planner_unavailable"|"no_scenario"|"capacity_exceeded"|"owner_link_missing";
export type OliviaCommandError={ok:false;version:1;status:"error";error:Code};
const fail=(error:Code):OliviaCommandError=>({ok:false,version:1,status:"error",error});
const known=new Set<Code>([
  "invalid_input","unauthorized","disabled","not_found","ambiguous_employee",
  "inactive_employee","revision_conflict","source_changed","invalid_record",
  "storage_unavailable","missing_inputs","planner_unavailable","no_scenario",
  "capacity_exceeded","owner_link_missing",
]);
const domainFail=(error:unknown):OliviaCommandError=>
  fail(known.has(error as Code)?error as Code:"storage_unavailable");
async function stillOwner(businessId:string):Promise<boolean>{
  const owner=await requireSchedulingOwner();
  return !!owner && owner.businessId===businessId;
}
async function sourceToken(
  owner:NonNullable<Awaited<ReturnType<typeof requireSchedulingOwner>>>,
):Promise<string|null>{
  const response=await owner.supabase.rpc("scheduling_owner_source_token",{
    p_business_id:owner.businessId,
  });
  const value=response.data;
  return !response.error && typeof value==="string" &&
    /^[a-f0-9]{32}$/.test(value)?value:null;
}

/** No write, no flag changes, no model identity/role/café authority. */
export async function prepareOliviaAvailabilityCommand(raw:unknown){
  const input=oliviaPrepareAvailabilitySchema.safeParse(raw);
  if(!input.success)return fail("invalid_input");
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
      process.env.SCHEDULING_AVAILABILITY_UI_ENABLED!=="true")
    return fail("disabled");
  const owner=await requireSchedulingOwner();
  if(!owner)return fail("unauthorized");
  try{
    const before=await sourceToken(owner);
    if(!before)return fail("storage_unavailable");
    const saved=await executeOliviaReadCapability({
      capability:"olivia.availability.read",version:1,
    });
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!saved.ok)return domainFail(saved.error.code);
    if(saved.capability!=="olivia.availability.read" ||
       saved.source.businessId!==owner.businessId)return fail("invalid_record");
    const after=await sourceToken(owner);
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!after)return fail("storage_unavailable");
    if(before!==after)return fail("source_changed");
    const result=reconcileOliviaAvailability(
      input.data,saved.employees,owner.businessId,after);
    if(!result.ok)return fail(result.error);
    return {version:1 as const,status:"prepared" as const,
      ...result,requiresOwnerAction:true as const};
  }catch{return fail("storage_unavailable");}
}

const batchOutput=z.object({
  batchIndex:z.number().int().nonnegative(),
  records:z.array(z.object({
    id:z.string().uuid(),revision:z.number().int().positive(),
  }).strict()).max(200),
}).strict();
const commitOutput=z.object({
  actorId:z.string().uuid(),replayed:z.boolean(),
  batches:z.array(batchOutput).min(1).max(40),
}).strict();

/**
 * Effectful only with an OPAQUE separately issued trusted owner UI action.
 * There is deliberately no route, model dispatcher or Supervisor registration.
 * SQL rechecks the owner, locks source data, performs all batches atomically,
 * and reuses existing per-scope CAS/idempotency/audit triggers.
 */
export async function commitOliviaConfirmedAvailability(
  raw:unknown, ownerAction:OliviaOwnerActionProof,
){
  const input=oliviaConfirmedCommitSchema.safeParse(raw);
  if(!input.success)return fail("invalid_input");
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
      process.env.SCHEDULING_AVAILABILITY_UI_ENABLED!=="true")
    return fail("disabled");
  const owner=await requireSchedulingOwner();
  if(!owner || owner.businessId!==input.data.proposal.businessId)
    return fail("unauthorized");
  try{
    const auth=await owner.supabase.auth.getUser();
    const actor=auth.data.user?.id;
    if(auth.error||!actor)return fail("unauthorized");
    const digest=oliviaProposalDigest(input.data.proposal);
    if(digest!==input.data.proposalDigest)return fail("invalid_input");
    // Validate proof and consume exactly once BEFORE touching any write RPC.
    if(!consumeOliviaOwnerActionProof(ownerAction,owner.businessId,actor,digest,
        input.data.requestKey))return fail("unauthorized");
    const {data,error}=await owner.supabase.rpc("scheduling_olivia_commit_availability",{
      p_business_id:owner.businessId,
      p_source_token:input.data.proposal.sourceToken,
      p_request_key:input.data.requestKey,
      p_batches:input.data.proposal.batches,
    });
    if(error?.code==="P4B01")return fail("revision_conflict");
    if(error||!data)return fail("storage_unavailable");
    const value=data as Record<string,unknown>;
    if(value.error!==undefined){
      if(value.error==="conflict")return fail("revision_conflict");
      return domainFail(value.error);
    }
    const output=commitOutput.safeParse(data);
    if(!output.success || output.data.actorId!==actor ||
       output.data.batches.length!==input.data.proposal.batches.length ||
       output.data.batches.some((b,i)=>b.batchIndex!==i ||
         b.records.length!==input.data.proposal.batches[i].desired.length))
      return fail("invalid_record");
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    // An RPC acknowledgment is not enough: independently read ALL saved
    // employee scopes and compare exact rows/revisions to each desired row.
    const saved=await executeOliviaReadCapability({
      capability:"olivia.availability.read",version:1,
    });
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!saved.ok)return domainFail(saved.error.code);
    if(saved.capability!=="olivia.availability.read" ||
       saved.source.businessId!==owner.businessId)return fail("invalid_record");
    for(const [i,batch] of input.data.proposal.batches.entries()){
      const person=saved.employees.find(e=>e.employeeId===batch.employeeId);
      if(!person)return fail("invalid_record");
      const rows=batch.kind==="availability_rule"?person.recurring:person.exceptions;
      const within=rows.filter(r=>(r.location_id??null)===batch.locationId &&
        (batch.kind==="availability_rule"
          ? "effective_from" in r && r.effective_from===batch.scope.effective_from &&
            (r.effective_to??null)===batch.scope.effective_to
          : "local_date" in r && r.local_date===batch.scope.local_date));
      if(within.length!==batch.desired.length)return fail("invalid_record");
      for(const [j,item] of batch.desired.entries()){
        const receipt=output.data.batches[i].records[j];
        if(item.id && item.id!==receipt.id)return fail("invalid_record");
        const row=within.find(r=>r.id===receipt.id && r.revision===receipt.revision);
        if(!row)return fail("invalid_record");
        const target=foundationRecordSchemas[batch.kind];
        // Compare only canonical persisted business fields. DB may serialize
        // optional null columns; those cannot change owner intent.
        const stored=Object.fromEntries(Object.keys(target.shape)
          .filter(k=>k in row).map(k=>[k,(row as unknown as Record<string,unknown>)[k]]));
        const parsed=target.safeParse(stored);
        if(!parsed.success)return fail("invalid_record");
        for(const [key,desired] of Object.entries(item.data)){
          if(JSON.stringify((parsed.data as Record<string,unknown>)[key])!==
              JSON.stringify(desired))return fail("invalid_record");
        }
      }
    }
    return {ok:true as const,version:1 as const,status:"committed" as const,
      businessId:owner.businessId,actorId:actor,replayed:output.data.replayed,
      batches:output.data.batches,disposition:"saved_availability_only" as const};
  }catch{return fail("storage_unavailable");}
}

/** PR3 creates the inert schedule draft; PR4A proves exact saved assignment readback. */
export async function createOliviaScheduleDraftCommand(raw:unknown){
  const request=oliviaCreateDraftSchema.safeParse(raw);
  if(!request.success)return fail("invalid_input");
  const owner=await requireSchedulingOwner();
  if(!owner)return fail("unauthorized");
  try{
    const input=request.data;
    const preview=await executeOliviaReadCapability({
      capability:"olivia.schedule.preview",version:1,week:input.week,
      options:{objective:input.objective,
        expectedSourceDigest:input.expectedSourceDigest,
        expectedRevision:input.expectedRevision},
    });
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!preview.ok)return domainFail(preview.error.code);
    if(preview.capability!=="olivia.schedule.preview" ||
       preview.source.businessId!==owner.businessId)return fail("invalid_record");
    if(!preview.selectedScenario)return fail("no_scenario");
    const saved=await saveOliviaWeekDraft({
      week:input.week,objective:input.objective,
      expectedSourceDigest:input.expectedSourceDigest,
      expectedRevision:input.expectedRevision,requestKey:input.requestKey,
    });
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!saved.ok)return domainFail(saved.error);
    const persisted=await executeOliviaReadCapability({
      capability:"olivia.schedule.revision.read",version:1,
      week:input.week,revisionId:saved.revisionId,
    });
    if(!(await stillOwner(owner.businessId)))return fail("unauthorized");
    if(!persisted.ok)return domainFail(persisted.error.code);
    if(persisted.capability!=="olivia.schedule.revision.read" ||
       persisted.source.businessId!==owner.businessId ||
       persisted.revision!==saved.revision ||
       persisted.sourceDigest!==input.expectedSourceDigest ||
       oliviaCanonicalJson(persisted.scenario)!==oliviaCanonicalJson(saved.scenario) ||
       persisted.revisionStatus!=="draft")
      return fail("invalid_record");
    const scenario=persisted.scenario;
    const missingInputs=preview.notices.filter(n=>[
      "wage_unknown","availability_missing","unconfirmed_absence",
      "limits_missing","policy_unverified","coverage_unconfirmed",
      "legacy_schedules",
    ].includes(n.code));
    const readyForOwnerApproval=scenario.completeCoverage &&
      scenario.hardConstraintsSatisfied && scenario.gaps.length===0 &&
      scenario.legalReview==="verified_profile" &&
      scenario.cost.costState!=="unavailable" && missingInputs.length===0;
    const result={ok:true as const,version:1 as const,status:"saved_draft" as const,
      businessId:owner.businessId,week:input.week,
      seriesId:saved.seriesId,revisionId:saved.revisionId,
      revision:saved.revision,revisionStatus:"draft" as const,replayed:saved.replayed,
      sourceDigest:persisted.sourceDigest,
      objective:scenario.objective,assignments:persisted.assignments,
      coverage:{complete:scenario.completeCoverage,gaps:scenario.gaps,
        hardConstraintsSatisfied:scenario.hardConstraintsSatisfied},
      costs:scenario.cost,missingInputs,missingQualifications:
        scenario.gaps.filter(g=>g.reason==="qualification_missing"),
      warnings:preview.plan.warnings,
      notices:preview.notices,legalReview:scenario.legalReview,
      readyForOwnerApproval,readyForPublication:false as const,
      disposition:"persisted_draft_only" as const};
    const validated=oliviaSavedDraftCommandResponseSchema.safeParse(result);
    return validated.success?validated.data:fail("invalid_record");
  }catch{return fail("storage_unavailable");}
}
