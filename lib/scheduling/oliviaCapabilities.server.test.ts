import {beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({
  owner:vi.fn(),foundation:vi.fn(),preview:vi.fn(),history:vi.fn(),revision:vi.fn(),
  staff:[] as Array<Record<string,unknown>>,
  assignments:[] as Array<Record<string,unknown>>,
  calls:[] as string[],
  failure:null as string|null,
  staffRowCap:null as number|null,
  assignmentRowCap:null as number|null,
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
  effective_from:week,effective_to:null,business_id:businessId,...provenance,
};
const leave={
  id:uid(101),revision:1,employee_id:employeeId,location_id:null,
  local_date:"2026-10-14",exception_type:"approved_leave",
  start_local:null,end_local:null,max_minutes:null,overnight:false,
  business_id:businessId,...provenance,
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
          const rowCap=table==="employees"?m.staffRowCap??max:m.assignmentRowCap??max;
          return {data:rows.slice(0,Math.min(max,rowCap)),error:null,count:rows.length};
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
    m.calls=[];m.failure=null;m.staffRowCap=null;m.assignmentRowCap=null;
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
  it("reports inactive employees and confirmed negative-only evidence as unavailable",async()=>{
    m.staff=[{...m.staff[0],active:false}];
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{active:false,state:"unavailable"}]});
    m.staff=[{...m.staff[0],active:true}];
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_exception:[leave],
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{
        state:"unavailable",exceptions:[{exception_type:"approved_leave"}],
      }]});
  });
  it("preserves verified source attribution and confirmation timestamps",async()=>{
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:[{
        ...recurring,confirmed_at:iso,confirmed_by:uid(55),
        created_at:iso,updated_at:iso,updated_by:uid(55),
      }],
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:true,employees:[{
        recurring:[{source:"owner_direct",confirmation:"owner_confirmed",
          confirmed_at:iso,confirmed_by:uid(55),updated_at:iso}],
      }]});
  });
  it("detects incomplete PostgREST staff lists instead of silently omitting employees",async()=>{
    m.staff=[...m.staff,{id:uid(2),display_name:"Zara",active:true,
      business_id:businessId}];
    m.staffRowCap=1;
    expect(await executeOliviaReadCapability({capability:"olivia.availability.read",
      version:1})).toMatchObject({ok:false,error:{code:"storage_unavailable"}});
    expect(m.foundation).not.toHaveBeenCalled();
    m.staffRowCap=null;
    expect(await executeOliviaReadCapability({capability:"olivia.availability.read",
      version:1})).toMatchObject({ok:true,employees:[{},{}]});
  });
  it("rejects foreign or orphaned employee evidence even when it comes from an unexpected source read",async()=>{
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:[{...recurring,business_id:otherBusinessId}],
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:[{...recurring,employee_id:uid(99)}],
    },audit:[]});
    expect(await executeOliviaReadCapability({
      capability:"olivia.availability.read",version:1,
    })).toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects a capped employee count and transient employee-query errors",async()=>{
    m.staff=Array.from({length:501},(_,i)=>({
      id:uid(i+1),display_name:"Staff",active:true,business_id:businessId,
    }));
    expect(await executeOliviaReadCapability({capability:"olivia.availability.read",
      version:1})).toMatchObject({ok:false,error:{code:"capacity_exceeded"}});
  });
  it("preserves confirmed hour caps, qualifications, and verified-zero vs unknown compensation",async()=>{
    const records={
      ...emptyRecords(),availability_rule:[recurring],
      preferences:[{id:uid(110),revision:1,employee_id:employeeId,
        effective_from:week,effective_to:null,min_weekly_minutes:0,
        desired_weekly_minutes:null,max_weekly_minutes:1200,max_daily_minutes:240,
        unavailable_weekdays:[],business_id:businessId,...provenance}],
      qualification:[{id:uid(111),revision:1,employee_id:employeeId,
        location_id:locationId,qualification_code:"barista",valid_from:week,
        valid_to:null,business_id:businessId,...provenance}],
      compensation:[{id:uid(112),revision:1,employee_id:employeeId,
        cash_cost_state:"known_eligible_zero",
        eligibility_reference:"Verified compensation exception",
        eligibility_verified_by:uid(50),eligibility_verified_at:iso,
        business_id:businessId}],
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
  it("preserves all PR3 wage/availability notices for valid 51-worker previews",async()=>{
    const notices=Array.from({length:51},(_,i)=>[
      {code:"wage_unknown",employeeName:`Worker ${i}`},
      {code:"availability_missing",employeeName:`Worker ${i}`},
    ]).flat();
    m.preview.mockResolvedValueOnce({ok:true,plan,notices,blockers:[],
      employees:{[employeeId]:"Asha"},locationNames:{[locationId]:"Main"},
      previewRevision:2,sourceDigest:digest,frozenShiftKeys:[]});
    const result=await executeOliviaReadCapability(preview());
    expect(result.ok).toBe(true);
    if(!result.ok)throw Error("valid preview should be accepted");
    expect(result.capability).toBe("olivia.schedule.preview");
    if(result.capability!=="olivia.schedule.preview")throw Error("wrong capability");
    expect(result.notices).toEqual(notices);
    expect(result.notices).toHaveLength(102);
  });
  it("rejects unsafe aggregate cents and unsafe signed comparison deltas",async()=>{
    const unsafe=Number.MAX_SAFE_INTEGER+1;
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[{...scenario,cost:{
        ...scenario.cost,cashWagesCents:unsafe,
      }}]},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},
      previewRevision:2,sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,comparisons:[{left:"cash",right:"balanced",
        ownerMinutesDifference:0,cashWagesDifferenceCents:-unsafe,
        loadedPayrollDifferenceCents:null}],
    },notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},
      previewRevision:2,sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
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
      status:"feasible",proof:"complete_candidate_solution",
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
  it("preserves actionable typed blockers from trusted PR3 setup failures",async()=>{
    m.preview.mockResolvedValueOnce({ok:false,error:"missing_inputs",blockers:[
      {code:"no_location"},{code:"no_coverage"},
      {code:"conflicting_limits",employeeName:"Asha"},
    ]});
    const result=await executeOliviaReadCapability(preview());
    expect(result).toMatchObject({ok:false,error:{code:"missing_inputs"},
      blockers:[{code:"no_location"},{code:"no_coverage"},
        {code:"conflicting_limits",employeeName:"Asha"}]});
    m.preview.mockResolvedValueOnce({ok:false,error:"missing_inputs",blockers:[
      {code:"conflicting_limits",employeeName:"Asha",privateProviderError:"secret"},
    ]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.preview.mockResolvedValueOnce({ok:false,error:"missing_inputs",blockers:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("accepts 5,376 legitimate gaps and reports explicit capacity beyond 20,000",async()=>{
    const gap=scenario.gaps[0];
    const manyGaps=Array.from({length:5376},()=>({...gap}));
    const manyScenario={...scenario,gaps:manyGaps};
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[manyScenario],best:manyScenario},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},previewRevision:2,
      sourceDigest:digest,frozenShiftKeys:[]});
    const accepted=await executeOliviaReadCapability(preview());
    expect(accepted.ok).toBe(true);
    if(!accepted.ok)throw Error("valid 5-minute grid gaps should be supported");
    if(accepted.capability!=="olivia.schedule.preview")throw Error("wrong capability");
    expect(accepted.plan.scenarios[0].gaps).toHaveLength(5376);

    const aboveLimit={...scenario,gaps:Array.from({length:20_001},()=>gap)};
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[aboveLimit],best:aboveLimit},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},previewRevision:2,
      sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"capacity_exceeded"}});
  });
  it("reports PR2's valid 201-shift preview as capacity, not corrupted evidence",async()=>{
    const large={...scenario,shifts:Array.from({length:201},(_,i)=>({
      ...shift,employeeId:uid(i+1),
    }))};
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[large],best:large},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},previewRevision:2,
      sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"capacity_exceeded"}});
  });
  it("distinguishes oversized valid planner output from malformed over-cap evidence",async()=>{
    const tooMany=Array.from({length:201},(_,i)=>({...shift,employeeId:uid(i+1)}));
    const malformed={...scenario,shifts:tooMany,cost:{
      ...scenario.cost,cashWagesCents:-1,
    }};
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[malformed],best:malformed},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},previewRevision:2,
      sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    const gap=scenario.gaps[0];
    const invalidGaps={...scenario,gaps:Array.from({length:20_001},(_,i)=>({
      ...gap,...(i===20_000?{startAt:"not-datetime"}:{}),
    }))};
    m.preview.mockResolvedValueOnce({ok:true,plan:{
      ...plan,scenarios:[invalidGaps],best:invalidGaps},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},previewRevision:2,
      sourceDigest:digest,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
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
  it("blocks another café's missing-input evidence after mid-preview owner switch",async()=>{
    m.owner.mockResolvedValueOnce({businessId,supabase:client()})
      .mockResolvedValueOnce({businessId:otherBusinessId,supabase:client()});
    m.preview.mockResolvedValueOnce({ok:false,error:"missing_inputs",
      blockers:[{code:"conflicting_limits",employeeName:"Private Worker"}]});
    const result=await executeOliviaReadCapability(preview());
    expect(result).toMatchObject({ok:false,error:{code:"unauthorized"}});
    expect(JSON.stringify(result)).not.toContain("Private Worker");
    expect(JSON.stringify(result)).not.toContain("conflicting_limits");
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
  it("rejects incomplete immutable revision histories with a valid latest pointer",async()=>{
    m.history.mockResolvedValueOnce({ok:true,currentRevision:3,publishedRevision:1,
      revisions:[
        {id:uid(33),revision:3,status:"draft",created_at:iso},
        {id:uid(32),revision:1,status:"published",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(history()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:3,publishedRevision:1,
      revisions:[
        {id:uid(33),revision:3,status:"draft",created_at:iso},
        {id:uid(34),revision:4,status:"superseded",created_at:iso},
        {id:uid(32),revision:1,status:"published",created_at:iso},
      ]});
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
  it("verifies the official published pointer and requested row in revision readback",async()=>{
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,publishedRevision:1,
      revisions:[
        {id:revisionId,revision:2,status:"draft",created_at:iso},
        {id:uid(32),revision:1,status:"draft",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,publishedRevision:2,
      revisions:[
        {id:revisionId,revision:2,status:"published",created_at:iso},
        {id:uid(32),revision:1,status:"superseded",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"revision_conflict"}});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,publishedRevision:1,
      revisions:[
        {id:uid(33),revision:2,status:"draft",created_at:iso},
        {id:uid(32),revision:1,status:"published",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects truncated persisted assignments even if returned shifts match the scenario",async()=>{
    m.assignments.push({
      ...m.assignments[0],employee_id:uid(2),
    });
    m.assignmentRowCap=1;
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"storage_unavailable"}});
    m.assignmentRowCap=null;
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("does not hide corrupt or cross-tenant overflow records as capacity errors",async()=>{
    const bulk=Array.from({length:5001},(_,i)=>({
      ...recurring,id:uid(i+1000),
    }));
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:bulk,
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:false,error:{code:"capacity_exceeded"}});
    bulk[5000]={...bulk[5000],business_id:otherBusinessId};
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:bulk,
    },audit:[]});
    expect(await executeOliviaReadCapability(availability()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    bulk[5000]={...bulk[5000],business_id:businessId,employee_id:uid(997)};
    m.foundation.mockResolvedValueOnce({ok:true,records:{
      ...emptyRecords(),availability_rule:bulk,
    },audit:[]});
    expect(await executeOliviaReadCapability({
      capability:"olivia.availability.read",version:1,
    })).toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects internally contradictory planner cost states instead of trusting false zero or certainty",async()=>{
    const invalid=[
      {...scenario.cost,costState:"verified"},
      {...scenario.cost,cashWagesCents:0},
      {...scenario.cost,allocatedSalaryCents:0},
      {...scenario.cost,loadedPayrollCents:0},
      {...scenario.cost,costState:"estimate",missingWageEmployeeIds:[]},
      {...scenario.cost,costState:"unavailable",missingWageEmployeeIds:[]},
    ];
    for(const cost of invalid){
      const corrupted={...scenario,cost};
      m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
        scenarios:[corrupted],best:corrupted},
        notices:[],blockers:[],employees:{[employeeId]:"Asha"},
        locationNames:{[locationId]:"Main"},sourceDigest:digest,
        previewRevision:0,frozenShiftKeys:[]});
      expect(await executeOliviaReadCapability(preview()))
        .toMatchObject({ok:false,error:{code:"invalid_record"}});
    }
  });
  it("requires a loaded payroll total when planner labels costs verified",async()=>{
    const incomplete={...scenario,cost:{
      ...scenario.cost,costState:"verified",missingWageEmployeeIds:[],
      cashWagesCents:0,allocatedSalaryCents:0,loadedPayrollCents:null,
    }};
    m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
      scenarios:[incomplete],best:incomplete},notices:[],blockers:[],
      employees:{[employeeId]:"Asha"},locationNames:{[locationId]:"Main"},
      sourceDigest:digest,previewRevision:0,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects orphaned or multiple published history statuses without a matching unique pointer",async()=>{
    const entries=[
      {id:revisionId,revision:2,status:"draft",created_at:iso},
      {id:uid(32),revision:1,status:"published",created_at:iso},
    ];
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,
      publishedRevision:null,revisions:entries});
    expect(await executeOliviaReadCapability(history()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,
      publishedRevision:1,revisions:entries.map(x=>({...x,status:"published"}))});
    expect(await executeOliviaReadCapability(history()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
    m.revision.mockResolvedValueOnce({ok:true,revision:2,status:"draft",
      currentRevision:2,publishedRevision:null,scenario,sourceDigest:digest});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,
      publishedRevision:null,revisions:entries});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects mismatched feasibility status, proof, and best scenario witness",async()=>{
    const variants=[
      {...plan,status:"feasible",best:null,scenarios:[],
        proof:"complete_candidate_solution"},
      {...plan,status:"feasible",proof:"complete_candidate_solution"},
      {...plan,status:"unproven",proof:"complete_candidate_solution"},
      {...plan,best:{...scenario,ownerMinutes:10}},
      {...plan,best:null},
      {...plan,status:"infeasible",proof:"candidate_constraints_unresolved"},
    ];
    for(const bad of variants){
      m.preview.mockResolvedValueOnce({ok:true,plan:bad,notices:[],
        blockers:[],employees:{[employeeId]:"Asha"},
        locationNames:{[locationId]:"Main"},previewRevision:0,
        sourceDigest:digest,frozenShiftKeys:[]});
      expect(await executeOliviaReadCapability(preview()))
        .toMatchObject({ok:false,error:{code:"invalid_record"}});
    }
  });
  it("rejects malformed trusted source digests and revisions before comparing stale tokens",async()=>{
    for(const details of [{sourceDigest:"broken",previewRevision:2},
      {sourceDigest:digest,previewRevision:-1}]){
      m.preview.mockResolvedValueOnce({ok:true,plan,notices:[],blockers:[],
        employees:{[employeeId]:"Asha"},locationNames:{[locationId]:"Main"},
        frozenShiftKeys:[],...details});
      expect(await executeOliviaReadCapability({...preview(),options:{
        expectedSourceDigest:"b".repeat(64),expectedRevision:3,
      }})).toMatchObject({ok:false,error:{code:"invalid_record"}});
    }
  });
  it("cross-checks every planner comparison against the scenario order and actual costs",async()=>{
    const cash={...scenario,objective:"cash",
      cost:{...scenario.cost,missingWageEmployeeIds:[],costState:"estimate",
        cashWagesCents:2000,allocatedSalaryCents:0,loadedPayrollCents:null}};
    const balanced={...scenario,objective:"balanced",
      cost:{...scenario.cost,missingWageEmployeeIds:[],costState:"estimate",
        cashWagesCents:1700,allocatedSalaryCents:0,loadedPayrollCents:null}};
    const good={left:"cash",right:"balanced",
      ownerMinutesDifference:0,cashWagesDifferenceCents:-300,
      loadedPayrollDifferenceCents:null};
    const cases=[
      [{...good,cashWagesDifferenceCents:300},false],
      [{...good,cashWagesDifferenceCents:0},false],
      [{...good,loadedPayrollDifferenceCents:0},false],
      [{...good,left:"owner_time"},false],
      [good,true],
    ] as const;
    for(const [comparison,valid] of cases){
      m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
        scenarios:[cash,balanced],best:cash,comparisons:[comparison]},
        notices:[],blockers:[],employees:{[employeeId]:"Asha"},
        locationNames:{[locationId]:"Main"},sourceDigest:digest,
        previewRevision:0,frozenShiftKeys:[]});
      expect(await executeOliviaReadCapability(preview()))
        .toMatchObject(valid?{ok:true}:{ok:false,error:{code:"invalid_record"}});
    }
    const unknown={...balanced,cost:{...scenario.cost}};
    m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
      scenarios:[cash,unknown],best:cash,comparisons:[good]},
      notices:[],blockers:[],employees:{[employeeId]:"Asha"},
      locationNames:{[locationId]:"Main"},sourceDigest:digest,
      previewRevision:0,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
      .toMatchObject({ok:false,error:{code:"invalid_record"}});
  });
  it("rejects invalid temporal intervals, breaks, paid duration and gaps in planner output",async()=>{
    const invalidShifts=[
      {...shift,startAt:to,endAt:iso},
      {...shift,startAt:iso,endAt:iso},
      {...shift,paidMinutes:300},
      {...shift,breaks:[{startAt:to,endAt:iso,paid:false}]},
      {...shift,breaks:[{startAt:"2026-10-12T08:00:00.000Z",
        endAt:"2026-10-12T09:15:00.000Z",paid:false}]},
      {...shift,breaks:[{startAt:"2026-10-12T10:00:00.000Z",
        endAt:"2026-10-12T11:00:00.000Z",paid:false},{
        startAt:"2026-10-12T10:30:00.000Z",
        endAt:"2026-10-12T11:30:00.000Z",paid:false}]},
    ];
    for(const bad of invalidShifts){
      const invalidScenario={...scenario,shifts:[bad]};
      m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
        scenarios:[invalidScenario],best:invalidScenario},
        notices:[],blockers:[],employees:{[employeeId]:"Asha"},
        locationNames:{[locationId]:"Main"},sourceDigest:digest,
        previewRevision:0,frozenShiftKeys:[]});
      expect(await executeOliviaReadCapability(preview()))
        .toMatchObject({ok:false,error:{code:"invalid_record"}});
    }
    const badScenario={...scenario,gaps:[{...scenario.gaps[0],startAt:to,endAt:iso}]};
    m.preview.mockResolvedValueOnce({ok:true,plan:{...plan,
      scenarios:[badScenario],best:badScenario},notices:[],blockers:[],
      employees:{[employeeId]:"Asha"},locationNames:{[locationId]:"Main"},
      sourceDigest:digest,previewRevision:0,frozenShiftKeys:[]});
    expect(await executeOliviaReadCapability(preview()))
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
  it("uses only read surfaces and never touches attendance, payroll, or legacy schedules",async()=>{
    expect((await executeOliviaReadCapability(availability())).ok).toBe(true);
    expect((await executeOliviaReadCapability(preview())).ok).toBe(true);
    expect((await executeOliviaReadCapability(history())).ok).toBe(true);
    expect((await executeOliviaReadCapability(revision())).ok).toBe(true);
    expect(m.calls).toEqual(["employees","scheduling_plan_assignments"]);
    expect(m.calls).not.toContain("timecards");
    expect(m.calls).not.toContain("staff_schedules");
    expect(m.calls).not.toContain("payroll");
  });
  it("distinguishes persisted approved and published versions without running transitions",async()=>{
    m.revision.mockResolvedValueOnce({ok:true,revision:2,status:"approved",
      currentRevision:2,publishedRevision:1,scenario,sourceDigest:digest});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,publishedRevision:1,
      revisions:[
        {id:revisionId,revision:2,status:"approved",created_at:iso},
        {id:uid(32),revision:1,status:"published",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:true,status:"ok",revisionStatus:"approved",
        disposition:"stored_read_only"});
    m.revision.mockResolvedValueOnce({ok:true,revision:2,status:"published",
      currentRevision:2,publishedRevision:2,scenario,sourceDigest:digest});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:2,publishedRevision:2,
      revisions:[
        {id:revisionId,revision:2,status:"published",created_at:iso},
        {id:uid(32),revision:1,status:"superseded",created_at:iso},
      ]});
    expect(await executeOliviaReadCapability(revision()))
      .toMatchObject({ok:true,status:"ok",revisionStatus:"published",
        publishedRevision:2});
    expect(m.calls).toEqual(["scheduling_plan_assignments",
      "scheduling_plan_assignments"]);
  });
  it("fails closed on forged official pointers and marks multi-request reads provisional",async()=>{
    expect(await executeOliviaReadCapability(history())).toMatchObject({
      ok:true,source:{consistency:"provisional"}});
    expect(await executeOliviaReadCapability(revision())).toMatchObject({
      ok:true,source:{consistency:"provisional"}});
    m.history.mockResolvedValueOnce({ok:true,currentRevision:1,publishedRevision:2,
      revisions:[{id:revisionId,revision:1,status:"draft",created_at:iso}]});
    expect(await executeOliviaReadCapability(history())).toMatchObject({
      ok:false,error:{code:"invalid_record"}});
    m.revision.mockResolvedValueOnce({ok:true,revision:2,status:"approved",
      currentRevision:2,publishedRevision:2,scenario,sourceDigest:digest});
    expect(await executeOliviaReadCapability(revision())).toMatchObject({
      ok:false,error:{code:"invalid_record"}});
  });
  it("rejects a selected café switch during history read",async()=>{
    m.owner.mockResolvedValueOnce({businessId,supabase:client()})
      .mockResolvedValueOnce({businessId:otherBusinessId,supabase:client()});
    expect(await executeOliviaReadCapability(history()))
      .toMatchObject({ok:false,error:{code:"unauthorized"}});
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
