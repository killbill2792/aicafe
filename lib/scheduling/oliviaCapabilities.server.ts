import "server-only";

import { z } from "zod";
import { requireSchedulingOwner, readSchedulingFoundation } from "./foundation.server";
import {
  previewOliviaWeek, readOliviaPlanHistory, readOliviaPlanRevision,
} from "@/lib/actions/oliviaPlanning";
import {
  OLIVIA_CAPABILITY_VERSION, oliviaReadRequestSchema, oliviaReadResponseSchema,
  oliviaStoredSchemas, oliviaScenarioSchema, oliviaShiftSchema,
  oliviaUuid, oliviaAvailabilityEmployeeSchema, oliviaRevisionStatusSchema,
  type OliviaReadCapability, type OliviaReadRequest,
  type OliviaReadResponse,
} from "./oliviaCapabilityContracts";

/**
 * Olivia-only SERVER adapter; not a Supervisor registry/tool/endpoint.
 * No write services are imported. An unknown/model-authored capability cannot
 * trigger approval, publication, staff writes, SQL, or attendance changes.
 */
type ErrorCode = z.infer<typeof import("./oliviaCapabilityContracts").oliviaCapabilityErrorSchema>["error"]["code"];
const supported:readonly OliviaReadCapability[]=[
  "olivia.availability.read","olivia.schedule.preview",
  "olivia.schedule.history.read","olivia.schedule.revision.read",
];
function safeCapability(raw:unknown):OliviaReadCapability|"invalid_request" {
  const name=raw && typeof raw==="object" && "capability" in raw
    ? (raw as {capability:unknown}).capability : null;
  return typeof name==="string" && supported.includes(name as OliviaReadCapability)
    ? name as OliviaReadCapability : "invalid_request";
}
const messages:Record<ErrorCode,string>={
  invalid_input:"Invalid or unsupported Olivia request.",
  unauthorized:"Scheduling data is unavailable for this owner and café.",
  disabled:"Olivia scheduling is not enabled.",
  not_found:"No authorized scheduling record was found.",
  missing_inputs:"Confirmed scheduling inputs are incomplete.",
  source_changed:"Saved scheduling inputs have changed. Preview again.",
  revision_conflict:"The schedule revision has changed. Reload the schedule.",
  invalid_record:"Stored scheduling evidence is invalid or inconsistent.",
  storage_unavailable:"Scheduling data cannot be verified right now.",
  planner_unavailable:"A verified scheduling preview is unavailable.",
  capacity_exceeded:"Scheduling read exceeds the supported safe limit.",
};
function fail(capability:OliviaReadCapability|"invalid_request",code:ErrorCode):OliviaReadResponse {
  return {ok:false,capability,version:OLIVIA_CAPABILITY_VERSION,status:"error",
    error:{code,retryable:["storage_unavailable","planner_unavailable"].includes(code),
      message:messages[code]}};
}
function fromDomainError(capability:OliviaReadCapability,error:unknown):OliviaReadResponse {
  switch(error){
    case "invalid_input":case "unauthorized":case "disabled":case "not_found":
    case "missing_inputs":case "source_changed":case "revision_conflict":
    case "invalid_record":case "storage_unavailable":case "planner_unavailable":
      return fail(capability,error);
    default:return fail(capability,"storage_unavailable");
  }
}
function verified<T extends OliviaReadResponse>(
  capability:OliviaReadCapability, body:T,
):OliviaReadResponse {
  const result=oliviaReadResponseSchema.safeParse(body);
  return result.success?result.data:fail(capability,"invalid_record");
}
async function stillOwner(businessId:string):Promise<boolean> {
  const current=await requireSchedulingOwner();
  return !!current && current.businessId===businessId;
}
const rowTypes={
  availability_rule:oliviaStoredSchemas.recurring,
  availability_exception:oliviaStoredSchemas.exception,
  preferences:oliviaStoredSchemas.hours,
  preference_window:oliviaStoredSchemas.preferenceWindow,
  qualification:oliviaStoredSchemas.qualification,
  compensation:oliviaStoredSchemas.compensation,
} as const;
type Kind=keyof typeof rowTypes;

async function readAvailability(
  input:Extract<OliviaReadRequest,{capability:"olivia.availability.read"}>,
):Promise<OliviaReadResponse> {
  const capability=input.capability;
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true")
    return fail(capability,"disabled");
  const owner=await requireSchedulingOwner();
  if(!owner)return fail(capability,"unauthorized");

  // Even the optional employee lookup uses the authenticated café; a forged
  // employee ID cannot authorize or locate another tenant's record.
  let query=owner.supabase.from("employees")
    .select("id,display_name,active",{count:"exact"}).eq("business_id",owner.businessId);
  if(input.employeeId)query=query.eq("id",input.employeeId);
  const {data:staff,error:staffError,count}=await query.order("id").limit(501);
  if(staffError || !staff || count===null)
    return fail(capability,"storage_unavailable");
  if(count>500)return fail(capability,"capacity_exceeded");
  // Supabase deployments can cap PostgREST result pages below 501 rows.
  // A truncated staff roster must never masquerade as complete availability.
  if(staff.length!==count)return fail(capability,"storage_unavailable");
  if(input.employeeId && staff.length!==1)return fail(capability,"not_found");
  const ids=new Set<string>();
  for(const employee of staff){
    if(!oliviaUuid.safeParse(employee.id).success || ids.has(employee.id) ||
       typeof employee.display_name!=="string" ||
       employee.display_name.length<1 || employee.display_name.length>240 ||
       typeof employee.active!=="boolean")
      return fail(capability,"invalid_record");
    ids.add(employee.id);
  }

  const found=await readSchedulingFoundation();
  if(!found.ok)return fromDomainError(capability,found.error);
  if(!(await stillOwner(owner.businessId)))return fail(capability,"unauthorized");
  const grouped:Record<Kind,Map<string,unknown[]>>={
    availability_rule:new Map(),availability_exception:new Map(),
    preferences:new Map(),preference_window:new Map(),qualification:new Map(),
    compensation:new Map(),
  };
  for(const kind of Object.keys(rowTypes) as Kind[]){
    const raw=found.records[kind];
    if(!Array.isArray(raw) || raw.length>5000)
      return fail(capability,"capacity_exceeded");
    for(const value of raw){
      // readSchedulingFoundation is independently authenticated; reject
      // source records from any changed/mismatching tenant before projecting
      // their fields (which intentionally omit business_id).
      if(!value || typeof value!=="object" ||
         !("business_id" in value) ||
         (value as {business_id:unknown}).business_id!==owner.businessId)
        return fail(capability,"invalid_record");
      const parsed=rowTypes[kind].safeParse(value);
      if(!parsed.success)return fail(capability,"invalid_record");
      const id=parsed.data.employee_id;
      // A foreign/orphaned employee must never be emitted as an authorized
      // record. A filtered request must not confuse other local employees
      // with cross-tenant records, so verify against the café roster.
      if(input.employeeId && id!==input.employeeId)continue;
      if(!ids.has(id))return fail(capability,"invalid_record");
      const target=grouped[kind].get(id)??[];
      target.push(parsed.data);
      grouped[kind].set(id,target);
    }
  }
  const at=(kind:Kind,id:string)=>grouped[kind].get(id)??[];
  const employees=staff.map(employee=>{
    const id=employee.id as string;
    const recurring=at("availability_rule",id) as Array<z.infer<typeof oliviaStoredSchemas.recurring>>;
    const exceptions=at("availability_exception",id) as Array<z.infer<typeof oliviaStoredSchemas.exception>>;
    const hasConfirmedPositive=recurring.some(r=>r.confirmation==="owner_confirmed") ||
      exceptions.some(e=>e.confirmation==="owner_confirmed" &&
        (e.exception_type==="replace_day"||e.exception_type==="add_available"));
    const hasConfirmedUnavailable=exceptions.some(e=>
      e.confirmation==="owner_confirmed" &&
      (e.exception_type==="unavailable"||e.exception_type==="approved_leave"));
    const hasUnconfirmed=recurring.some(r=>r.confirmation==="unconfirmed") ||
      exceptions.some(e=>e.confirmation==="unconfirmed");
    // This is an evidence-level summary, NOT a per-day availability decision.
    // A confirmed leave still overrides a recurring window on that date in PR2.
    const state=!employee.active || (!hasConfirmedPositive && hasConfirmedUnavailable)
      ? "unavailable" as const
      : hasConfirmedPositive?"confirmed" as const
      : hasUnconfirmed?"unconfirmed" as const:"missing" as const;
    return {employeeId:id,displayName:employee.display_name as string,
      active:employee.active as boolean,
      state,
      recurring,exceptions,
      hourLimits:at("preferences",id),
      preferences:at("preference_window",id),
      qualifications:at("qualification",id),
      compensation:at("compensation",id)};
  });
  const validatedEmployees=z.array(oliviaAvailabilityEmployeeSchema).max(500).safeParse(employees);
  if(!validatedEmployees.success)return fail(capability,"invalid_record");
  return verified(capability,{
    ok:true,capability,version:1,status:"ok",
    source:{owner:"olivia",businessId:owner.businessId,kind:"stored_availability",
      consistency:"provisional"},
    employees:validatedEmployees.data,
  });
}
async function readPreview(
  input:Extract<OliviaReadRequest,{capability:"olivia.schedule.preview"}>,
):Promise<OliviaReadResponse> {
  const capability=input.capability;
  // PR3's action authenticates, loads trusted staff/coverage/wages, binds the
  // source digest and head revision, and calls the PR2 pure optimizer.
  const initialOwner=await requireSchedulingOwner();
  if(!initialOwner)return fail(capability,"unauthorized");
  const preview=await previewOliviaWeek({week:input.week});
  if(!preview.ok)return fromDomainError(capability,preview.error);
  if(input.options?.expectedSourceDigest &&
      input.options.expectedSourceDigest!==preview.sourceDigest)
    return fail(capability,"source_changed");
  if(input.options?.expectedRevision!==undefined &&
      input.options.expectedRevision!==preview.previewRevision)
    return fail(capability,"revision_conflict");
  const owner=await requireSchedulingOwner();
  if(!owner || owner.businessId!==initialOwner.businessId)
    return fail(capability,"unauthorized");
  const candidate=oliviaScenarioSchema.safeParse(
    input.options?.objective
      ? preview.plan.scenarios.find(x=>x.objective===input.options?.objective)??null
      : preview.plan.best);
  // A requested objective without a feasible scenario is a documented null,
  // not an invented alternative or a false coverage claim.
  const selected=candidate.success?candidate.data:null;
  return verified(capability,{
    ok:true,capability,version:1,status:"ok",
    source:{owner:"olivia",businessId:owner.businessId,kind:"trusted_preview",
      consistency:"provisional",sourceDigest:preview.sourceDigest},
    plan:preview.plan,selectedScenario:selected,
    previewRevision:preview.previewRevision,
    notices:preview.notices,blockers:preview.blockers,
    employeeNames:preview.employees,locationNames:preview.locationNames,
    frozenShiftKeys:preview.frozenShiftKeys,
    disposition:"proposal_only",
  });
}
async function readHistory(
  input:Extract<OliviaReadRequest,{capability:"olivia.schedule.history.read"}>,
):Promise<OliviaReadResponse> {
  const capability=input.capability;
  const initialOwner=await requireSchedulingOwner();
  if(!initialOwner)return fail(capability,"unauthorized");
  const history=await readOliviaPlanHistory({week:input.week});
  if(!history.ok)return fromDomainError(capability,history.error);
  const owner=await requireSchedulingOwner();
  if(!owner || owner.businessId!==initialOwner.businessId)
    return fail(capability,"unauthorized");
  const seen=new Set<number>();
  for(const row of history.revisions){
    if(seen.has(row.revision))return fail(capability,"invalid_record");
    seen.add(row.revision);
  }
  // Draft revisions are created consecutively and are immutable. A response
  // missing any intermediate version is incomplete, even if it contains HEAD.
  // This also detects silent PostgREST pagination truncation in PR3's reader.
  if(history.revisions.length!==history.currentRevision ||
     [...seen].some(v=>v<1 || v>history.currentRevision) ||
     (history.currentRevision===0 && history.revisions.length!==0) ||
     (history.publishedRevision!==null &&
       history.publishedRevision>history.currentRevision) ||
     (history.currentRevision>0 && !seen.has(history.currentRevision)) ||
     (history.publishedRevision!==null &&
      !history.revisions.some(x=>x.revision===history.publishedRevision &&
        x.status==="published")))
    return fail(capability,"invalid_record");
  return verified(capability,{
    ok:true,capability,version:1,status:"ok",
    source:{owner:"olivia",businessId:owner.businessId,kind:"stored_revisions",
      consistency:"provisional"},
    currentRevision:history.currentRevision,
    publishedRevision:history.publishedRevision,revisions:history.revisions,
  });
}
function shiftIdentity(shifts:readonly z.infer<typeof oliviaShiftSchema>[]):string {
  return JSON.stringify(shifts.map(s=>({...s,breaks:s.breaks.map(b=>({...b}))}))
    .sort((a,b)=>a.employeeId.localeCompare(b.employeeId) ||
      a.startAt.localeCompare(b.startAt) || a.locationId.localeCompare(b.locationId)));
}
async function readRevision(
  input:Extract<OliviaReadRequest,{capability:"olivia.schedule.revision.read"}>,
):Promise<OliviaReadResponse> {
  const capability=input.capability;
  const initialOwner=await requireSchedulingOwner();
  if(!initialOwner)return fail(capability,"unauthorized");
  const revision=await readOliviaPlanRevision({week:input.week,revisionId:input.revisionId});
  if(!revision.ok)return fromDomainError(capability,revision.error);
  const scenario=oliviaScenarioSchema.safeParse(revision.scenario);
  const revisionStatus=oliviaRevisionStatusSchema.safeParse(revision.status);
  if(!scenario.success || !revisionStatus.success ||
     revision.revision>revision.currentRevision ||
     (revision.publishedRevision===revision.revision &&
       revision.status!=="published") ||
     (revision.status==="published" && revision.publishedRevision!==revision.revision))
    return fail(capability,"invalid_record");
  const owner=await requireSchedulingOwner();
  if(!owner || owner.businessId!==initialOwner.businessId)
    return fail(capability,"unauthorized");
  // Unlike PR3's lightweight draft-picker, this capability also checks the
  // actual persisted assignment rows against the revision scenario, so a
  // malformed/stale DB projection cannot be presented as an official plan.
  const {data:rows,error}=await owner.supabase.from("scheduling_plan_assignments")
    .select("employee_id,location_id,starts_at,ends_at,paid_minutes,breaks,pinned")
    .eq("business_id",owner.businessId)
    .eq("plan_revision_id",input.revisionId).limit(201);
  if(error || !rows || rows.length>200)return fail(capability,"storage_unavailable");
  const assignments=[];
  for(const r of rows){
    if(typeof r.starts_at!=="string"||typeof r.ends_at!=="string")
      return fail(capability,"invalid_record");
    const start=new Date(r.starts_at),end=new Date(r.ends_at);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))
      return fail(capability,"invalid_record");
    const parsed=oliviaShiftSchema.safeParse({
      employeeId:r.employee_id,locationId:r.location_id,startAt:start.toISOString(),
      endAt:end.toISOString(),paidMinutes:r.paid_minutes,breaks:r.breaks,pinned:r.pinned,
    });
    if(!parsed.success)return fail(capability,"invalid_record");
    assignments.push(parsed.data);
  }
  if(shiftIdentity(assignments)!==shiftIdentity(scenario.data.shifts))
    return fail(capability,"invalid_record");
  if(!(await stillOwner(owner.businessId)))return fail(capability,"unauthorized");
  return verified(capability,{
    ok:true,capability,version:1,status:"ok",
    source:{owner:"olivia",businessId:owner.businessId,kind:"stored_revision",
      consistency:"provisional",sourceDigest:revision.sourceDigest},
    revisionId:input.revisionId,revision:revision.revision,revisionStatus:revisionStatus.data,
    currentRevision:revision.currentRevision,publishedRevision:revision.publishedRevision,
    sourceDigest:revision.sourceDigest,scenario:scenario.data,
    assignments,disposition:"stored_read_only",
  });
}
/** The ONLY public executor in PR4A. No owner-action dispatcher exists. */
export async function executeOliviaReadCapability(raw:unknown):Promise<OliviaReadResponse> {
  const request=oliviaReadRequestSchema.safeParse(raw);
  if(!request.success)return fail(safeCapability(raw),"invalid_input");
  try {
    switch(request.data.capability){
      case "olivia.availability.read":return await readAvailability(request.data);
      case "olivia.schedule.preview":return await readPreview(request.data);
      case "olivia.schedule.history.read":return await readHistory(request.data);
      case "olivia.schedule.revision.read":return await readRevision(request.data);
    }
  } catch {
    return fail(request.data.capability,"storage_unavailable");
  }
}
