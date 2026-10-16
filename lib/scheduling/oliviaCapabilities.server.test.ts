import {beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({
  owner:vi.fn(),foundation:vi.fn(),preview:vi.fn(),history:vi.fn(),revision:vi.fn(),
  staff:[] as Array<Record<string,unknown>>,
  assignments:[] as Array<Record<string,unknown>>,
  calls:[] as string[],
  failure:null as string|null,
}));
vi.mock("server-only",()=>({}));
vi.mock("./foundation.server",()=>({
  requireSchedulingOwner:m.owner,readSchedulingFoundation:m.foundation,
}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({
  previewOliviaWeek:m.preview,readOliviaPlanHistory:m.history,
  readOliviaPlanRevision:m.revision,
}));
import {executeOliviaReadCapability} from "./oliviaCapabilities.server";
import {
  futureOliviaOwnerIntentSchemas,oliviaReadRequestSchema,
} from "./oliviaCapabilityContracts";

const uid=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const businessId=uid(901);
const otherBusinessId=uid(902);
const employeeId=uid(1);
const locationId=uid(20);
const revisionId=uid(31);
const digest="a".repeat(64);
const week="2026-10-12";
const iso="2026-10-12T09:00:00.000Z";
const to="2026-10-12T13:00:00.000Z";
const shift={
  employeeId,locationId,startAt:iso,endAt:to,paidMinutes:240,
  breaks:[],pinned:false,
};
const scenario={
  objective:"balanced",shifts:[shift],
  gaps:[{coverageId:uid(40),locationId,startAt:iso,endAt:to,
    qualificationCode:"barista",missingHeadcount:1,reason:"qualification_missing"}],
  completeCoverage:false,hardConstraintsSatisfied:true,ownerMinutes:0,
  cost:{cashWagesCents:null,allocatedSalaryCents:null,loadedPayrollCents:null,
    ownerOpportunityCents:null,ownerMinutes:0,costState:"unavailable",
    missingWageEmployeeIds:[employeeId]},
  preferencePenalty:0,exploredNodes:100,legalReview:"unverified_profile",
};
const plan={
  status:"unproven",horizonStart:week,horizonEnd:"2026-10-18",
  scenarios:[scenario],best:scenario,comparisons:[],warnings:["Unknown wage"],
  proof:"candidate_constraints_unresolved",
};
const provenance={source:"owner_direct",confirmation:"owner_confirmed"};
const recurring={
  id:uid(100),revision:1,employee_id:employeeId,location_id:null,day_of_week:1,
  start_local:"09:00",end_local:"17:00",overnight:false,
  effective_from:week,effective_to:null,...provenance,
};
const leave={
  id:uid(101),revision:1,employee_id:employeeId,location_id:null,
  local_date:"2026-10-14",exception_type:"approved_leave",
  start_local:null,end_local:null,max_minutes:null,overnight:false,...provenance,
};
const emptyRecords=()=>({
  availability_rule:[] as unknown[],availability_exception:[] as unknown[],
  preferences:[] as unknown[],preference_window:[] as unknown[],
  qualification_type:[] as unknown[],qualification:[] as unknown[],
  coverage:[] as unknown[],compensation:[] as unknown[],
});
const availability=()=>({capability:"olivia.availability.read",version:1,employeeId});
const preview=()=>({capability:"olivia.schedule.preview",version:1,week});
const history=()=>({capability:"olivia.schedule.history.read",version:1,week});
const revision=()=>({capability:"olivia.schedule.revision.read",version:1,week,revisionId});
function client(){
  return {
    from:(table:string)=>{
      m.calls.push(table);
      const constraints:Array<[string,unknown]>=[];
      const q={
        select:()=>q,
        eq:(field:string,value:unknown)=>{constraints.push([field,value]);return q;},
        order:()=>q,
        limit:async(max:number)=>{
          if(m.failure===table)throw new Error("provider details should remain private");
          const rows=(table==="employees"?m.staff:m.assignments).filter(r=>
            constraints.every(([field,value])=>r[field]===value));
          return {data:rows.slice(0,max),error:null};
        },
      };
      return q;
    },
    rpc:()=>{throw Error("READ CAPABILITIES MUST NEVER CALL RPC");},
  };
}
describe("Olivia PR4A domain adapter: strict, owner-scoped, read-only",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    m.calls=[];m.failure=null;
    m.staff=[{id:employeeId,display_name:"Asha",active:true,business_id:businessId}];
    m.assignments=[{employee_id:employeeId,location_id:locationId,
      business_id:businessId,plan_revision_id:revisionId,
      starts_at:iso,ends_at:to,paid_minutes:240,breaks:[],pinned:false}];
    m.owner.mockImplementation(async()=>({businessId,supabase:client()}));
    m.foundation.mockResolvedValue({ok:true,records:{
      ...emptyRecords(),availability_rule:[recurring],availability_exception:[leave],
    },audit:[]});
    m.preview.mockResolvedValue({ok:true,plan,notices:[
      {code:"wage_unknown",employeeName:"Asha"},
      {code:"policy_unverified"},
    ],blockers:[],employees:{[employeeId]:"Asha"},
      locations:{[locationId]:"UTC"},locationNames:{[locationId]:"Main"},
      previewRevision:2,sourceDigest:digest,frozenShiftKeys:[]});
    m.history.mockResolvedValue({ok:true,currentRevision:2,publishedRevision:1,
      revisions:[
        {id:revisionId,revision:2,status:"draft",created_at:iso},
        {id:uid(32),revision:1,status:"published",created_at:iso},
      ]});
    m.revision.mockResolvedValue({ok:true,revision:2,status:"draft",
      currentRevision:2,publishedRevision:1,scenario,sourceDigest:digest});
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
  });

  it("rejects unknown executable approvals, invalid payloads, and forged business/wage fields",async()=>{
    for(const raw of [
      {capability:"olivia.schedule.publish",version:1,week},
      {...preview(),businessId:otherBusinessId},
      {...preview(),employees:[{id:employeeId,wage:0}]},
      {...preview(),week:"2026-10-13"},
      {...availability(),employeeId:"not-a-uuid"},
      {...revision(),revisionId:"broken"},
      {capability:"olivia.schedule.preview",version:2,week},
    ])expect(await executeOliviaReadCapability(raw)).toMatchObject({
      ok:false,error:{code:"invalid_input"}});
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.calls).toEqual([]);
  });
  it("enforces authenticated owner and existing café policy for reads and preview",async()=>{
    m.owner.mockResolvedValue(null);
    expect(await executeOliviaReadCapability(availability())).toMatchObject({
      ok:false,error:{code:"unauthorized"}});
    expect(await executeOliviaReadCapability(preview())).toMatchObject({
      ok:false,error:{code:"unauthorized"}});
    expect(m.preview).not.toHaveBeenCalled();
  });
  it("reads confirmed recurring windows and confirmed leave without treating leave as available",async()=>{
    const result=await executeOliviaReadCapability(availability());
    expect(result).toMatchObject({ok:true,status:"ok",version:1,
      source:{businessId,kind:"stored_availability"},
      employees:[{employeeId,state:"confirmed",recurring:[{day_of_week:1,
        start_local:"09:00"}],exceptions:[{exception_type:"approved_leave",
        confirmation:"owner_confirmed"}]}]});
    expect(m.calls).toEqual(["employees"]);
  });
  it("fails safely for forged IDs and foreign café memberships",async()=>{
    expect(await executeOliviaReadCapability({...availability(),employeeId:uid(99)}))
      .toMatchObject({ok:false,error:{code:"not_found"}});
    m.staff=[{...m.staff[0],business_id:otherBusinessId}];
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:false,error:{code:"not_found"}});
  });
  it("never upgrades unconfirmed or missing availability to confirmed",async()=>{
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:[{...recurring,confirmation:"unconfirmed"}],
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{state:"unconfirmed"}]});
    m.foundation.mockResolvedValueOnce({ok:true,records:emptyRecords(),audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{state:"missing"}]});
  });
  it("preserves confirmed hour caps, qualifications, and verified-zero vs unknown compensation",async()=>{
    const records={
      ...emptyRecords(),availability_rule:[recurring],
      preferences:[{id:uid(110),revision:1,employee_id:employeeId,
        effective_from:week,effective_to:null,min_weekly_minutes:0,
        desired_weekly_minutes:null,max_weekly_minutes:1200,max_daily_minutes:240,
        unavailable_weekdays:[],...provenance}],
      qualification:[{id:uid(111),revision:1,employee_id:employeeId,
        location_id:locationId,qualification_code:"barista",valid_from:week,
        valid_to:null,...provenance}],
      compensation:[{id:uid(112),revision:1,employee_id:employeeId,
        cash_cost_state:"known_eligible_zero",
        eligibility_reference:"Verified compensation exception",
        eligibility_verified_by:uid(50),eligibility_verified_at:iso}],
    };
    m.foundation.mockResolvedValueOnce({ok:true,records,audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{hourLimits:[{max_daily_minutes:240}],
        qualifications:[{qualification_code:"barista"}],
        compensation:[{cash_cost_state:"known_eligible_zero"}]}]});
    m.foundation.mockResolvedValueOnce({ok:true,records:{...records,
      compensation:[{...records.compensation[0],cash_cost_state:"unknown",
        eligibility_reference:null,eligibility_verified_by:null,
        eligibility_verified_at:null}]},audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{compensation:[{cash_cost_state:"unknown"}]}]});
  });
  it("previews the saved five-worker no-POS scenario, exact gaps and unknown costs without writing",async()=>{
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[{...scenario,shifts:[0,1,2,3,4].map(i=>({
        ...shift,employeeId:uid(i+1)}))}],
      best:{...scenario,shifts:[0,1,2,3,4].map(i=>({
        ...shift,employeeId:uid(i+1)}))},
    },notices:[{code:"wage_unknown"}],blockers:[],
    employees:Object.fromEntries([1,2,3,4,5].map(i=>[uid(i),`Staff ${i}`])),
    locations:{[locationId]:"UTC"},locationNames:{[locationId]:"Main"},
    previewRevision:0,sourceDigest:digest,frozenShiftKeys:[]});
    const result=await executeOliviaReadCapability(preview());
    expect(result).toMatchObject({ok:true,disposition:"proposal_only",
      plan:{status:"unproven",scenarios:[{shifts:[
        {},{},{},{},{}],gaps:[{reason:"qualification_missing",
          missingHeadcount:1}],cost:{cashWagesCents:null,costState:"unavailable"}}]}});
    expect(m.calls).toEqual([]);
  });
  it("distinguishes unknown wages from verified zero and preserves overnight UTC intervals",async()=>{
    const full={...scenario,
      shifts:[{...shift,startAt:"2026-11-01T05:30:00.000Z",
        endAt:"2026-11-01T09:30:00.000Z"}],
      gaps:[],completeCoverage:true,
      cost:{...scenario.cost,cashWagesCents:0,loadedPayrollCents:0,
        allocatedSalaryCents:0,missingWageEmployeeIds:[],costState:"verified"},
    };
    m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
      scenarios:[full],best:full},notices:[],blockers:[],
      employees:{[employeeId]:"Asha"},locations:{[locationId]:"America/New_York"},
      locationNames:{[locationId]:"Main"},sourceDigest:digest,
      previewRevision:0,frozenShiftKeys:[]});
    const result=await executeOliviaReadCapability({...preview(),
      options:{objective:"balanced"}});
    expect(result).toMatchObject({ok:true,
      selectedScenario:{cost:{cashWagesCents:0},shifts:[{
        startAt:"2026-11-01T05:30:00.000Z",endAt:"2026-11-01T09:30:00.000Z"}]}});
  });
  it("rejects stale source digests and revision conflicts without any write",async()=>{
    expect(await executeOliviaReadCapability({...preview(),options:{
      expectedSourceDigest:"b".repeat(64)}})).toMatchObject({
      ok:false,error:{code:"source_changed"}});
    expect(await executeOliviaReadCapability({...preview(),options:{
      expectedRevision:3}})).toMatchObject({
      ok:false,error:{code:"revision_conflict"}});
    expect(m.calls).toEqual([]);
  });
  it("refuses to return another café's preview if the active café switches",async()=>{
    m.owner.mockResolvedValueOnce({businessId,supabase:client()})
      .mockResolvedValueOnce({businessId:otherBusinessId,supabase:client()});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"unauthorized"}});
  });
  it("reports real revision history and separate official published pointer",async()=>{
    expect(await executeOliviaReadCapability(history())).toMatchObject({
      ok:true,currentRevision:2,publishedRevision:1,revisions:[
        {status:"draft"},{status:"published"}]});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,
      publishedRevision:1,revisions:[{id:revisionId,revision:2,
        status:"draft",created_at:iso}]});
    expect(await executeOliviaReadCapability(history()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("checks revision assignments against stored scenario before claiming a draft/approved/published state",async()=>{
    expect(await executeOliviaReadCapability(revision())).toMatchObject({
      ok:true,revisionId,revisionStatus:"draft",disposition:"stored_read_only",
      assignments:[{employeeId,paidMinutes:240}]});
    m.assignments=[{...m.assignments[0],paid_minutes:0}];
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.revision.mockResolvedValueOnce({ok:true,revision:1,status:"published",
      currentRevision:2,publishedRevision:1,scenario,sourceDigest:digest});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("fails closed on malformed read payloads and unavailable provider without leaking internals",async()=>{
    m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
      scenarios:[{...scenario,cost:{...scenario.cost,cashWagesCents:-1}}]},
      notices:[],blockers:[],employees:{},locations:{},locationNames:{},
      sourceDigest:digest,previewRevision:0,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.failure="employees";
    const result=await executeOliviaReadCapability(availability());
    expect(result).toMatchObject({ok:false,error:{code:"storage_unavailable"}});
    expect(JSON.stringify(result)).not.toContain("provider details");
  });
  it("keeps future owner action contracts declarative and never dispatchable",async()=>{
    expect(futureOliviaOwnerIntentSchemas.publish.safeParse({
      capability:"olivia.schedule.publish",version:1,week,revisionId,
      expectedRevision:1,requestKey:uid(40)}).success).toBe(true);
    expect(oliviaReadRequestSchema.safeParse({
      capability:"olivia.schedule.publish",version:1,week,revisionId,
      expectedRevision:1,requestKey:uid(40)}).success).toBe(false);
    expect(m.calls).toEqual([]);
  });
});
