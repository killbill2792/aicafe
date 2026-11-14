import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  load:vi.fn(), draft:vi.fn(), digest:vi.fn(), optimizer:vi.fn(), owner:vi.fn(),
}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/scheduling/planInput.server",()=>({
  loadOliviaWeekFromSavedStaff:mocks.load,
}));
vi.mock("@/lib/scheduling/planDrafts.server",()=>({
  createOliviaDraftFromTrustedSnapshot:mocks.draft,
  oliviaSnapshotDigest:mocks.digest,
}));
vi.mock("@/lib/calc/scheduling/plannerEngine",()=>({
  optimizeOliviaWeek:mocks.optimizer,
}));
vi.mock("@/lib/scheduling/foundation.server",()=>({
  requireSchedulingOwner:mocks.owner,
}));

import { previewOliviaWeek, previewOliviaAbsenceWhatIf, saveOliviaWeekDraft } from "./oliviaPlanning";

const businessId="10000000-0000-4000-8000-000000000001";
const requestKey="20000000-0000-4000-8000-000000000002";
const digest="a".repeat(64);
const input={
  horizonStart:"2026-10-12",
  locations:[{id:"loc",timezone:"UTC"}],
  employees:[{id:"emp",displayName:"Sarah",isOwner:undefined}],
  coverage:[],
};
const saved={ok:true,businessId,input,sourceFingerprint:"b".repeat(64),locationNames:{loc:"Main Café"},
  warnings:[],notices:[],blockers:[]};
const args={week:"2026-10-12",objective:"balanced",
  expectedRevision:0,expectedSourceDigest:digest,requestKey};

describe("Olivia preview/draft server action safety",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(saved);
    mocks.digest.mockReturnValue(digest);
    mocks.owner.mockResolvedValue({businessId,supabase:{from:()=>{
      const query={select:()=>query,eq:()=>query,
        maybeSingle:async()=>({data:{current_revision:4},error:null})};
      return query;
    }}});
    mocks.optimizer.mockReturnValue({status:"unproven",scenarios:[]});
    mocks.draft.mockResolvedValue({ok:true,seriesId:businessId,revision:1,
      revisionId:requestKey,replayed:false});
  });
  it("rejects forged staffing fields and malformed optimistic digest",async()=>{
    expect(await saveOliviaWeekDraft({...args,business_id:businessId}))
      .toEqual({ok:false,error:"invalid_input"});
    expect(await saveOliviaWeekDraft({...args,expectedSourceDigest:"bogus"}))
      .toEqual({ok:false,error:"invalid_input"});
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("never saves a different staff snapshot than the owner previewed",async()=>{
    mocks.digest.mockReturnValue("b".repeat(64));
    expect(await saveOliviaWeekDraft(args))
      .toEqual({ok:false,error:"source_changed"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("preserves tenant binding, week and stable request ID through internal draft service",async()=>{
    const result=await saveOliviaWeekDraft(args);
    expect(result).toMatchObject({ok:true,revision:1});
    expect(mocks.draft).toHaveBeenCalledWith({
      horizonStart:"2026-10-12",objective:"balanced",
      expectedRevision:0,requestKey,
    },input,businessId,"b".repeat(64));
  });
  it("does not fabricate owner-hours savings for an unlinked owner",async()=>{
    expect(await saveOliviaWeekDraft({...args,objective:"owner_time"}))
      .toEqual({ok:false,error:"owner_link_missing"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("returns actionable missing-coverage blocker and never drafts",async()=>{
    mocks.load.mockResolvedValue({...saved,blockers:[{code:"no_coverage"}]});
    expect(await saveOliviaWeekDraft(args))
      .toEqual({ok:false,error:"missing_inputs"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("previews a verifiable digest and display names without staff-record writes",async()=>{
    const result=await previewOliviaWeek({week:"2026-10-12"});
    expect(result).toMatchObject({
      ok:true,sourceDigest:digest,previewRevision:4,
      employees:{emp:"Sarah"},locations:{loc:"UTC"},
      locationNames:{loc:"Main Café"},
    });
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("rejects a selected café change while capturing the proposal revision",async()=>{
    mocks.owner.mockResolvedValueOnce({businessId:"another-cafe"});
    expect(await previewOliviaWeek({week:"2026-10-12"}))
      .toEqual({ok:false,error:"unauthorized"});
    expect(mocks.optimizer).not.toHaveBeenCalled();
  });
  it("fails closed when a proposal head cannot be read",async()=>{
    mocks.owner.mockResolvedValueOnce({businessId,supabase:{from:()=>{
      const q={select:()=>q,eq:()=>q,
        maybeSingle:async()=>({data:null,error:{code:"42501"}})};
      return q;
    }}});
    expect(await previewOliviaWeek({week:"2026-10-12"}))
      .toEqual({ok:false,error:"storage_unavailable"});
    expect(mocks.optimizer).not.toHaveBeenCalled();
  });
  it("does not preview plans lacking required confirmed staffing data",async()=>{
    mocks.load.mockResolvedValue({...saved,blockers:[{code:"no_coverage"}]});
    expect(await previewOliviaWeek({week:"2026-10-12"}))
      .toEqual({ok:false,error:"missing_inputs",blockers:[{code:"no_coverage"}]});
    expect(mocks.optimizer).not.toHaveBeenCalled();
  });

 it("simulates an exact owner's absence on the real planner without saving employee data",async()=>{
  const alice={id:"emp",displayName:"Sarah Jones",active:true,recurring:[],
    exceptions:[],qualifications:[],wage:{wage_period:"hour",wage_amount_cents:2100}};
  mocks.load.mockResolvedValue({...saved,input:{...input,employees:[alice]}});
  const basic={status:"feasible",horizonEnd:"2026-10-18",warnings:[],
    best:{completeCoverage:true,gaps:[],shifts:[{employeeId:"emp",
      locationId:"loc",startAt:"2026-10-13T16:00:00Z",endAt:"2026-10-13T17:00:00Z",
      paidMinutes:60,breaks:[],pinned:false}],
      cost:{cashWagesCents:2100}}};
  const simulated={...basic,status:"unproven",best:{
    completeCoverage:false,gaps:[{reason:"no_confirmed_availability"}],shifts:[],
    cost:{cashWagesCents:null}}};
  mocks.optimizer.mockReturnValueOnce(basic).mockReturnValueOnce(simulated);
  const result=await previewOliviaAbsenceWhatIf({
    week:"2026-10-12",employeeName:"Sarah",weekday:2});
  expect(result).toMatchObject({ok:true,employeeName:"Sarah Jones",
   absentDate:"2026-10-13",hypothetical:true,saved:false,published:false,
   baseline:{completeCoverage:true},alternative:{completeCoverage:false},
   changeInModeledCashWagesCents:null,laborCostDifferenceKnown:false,
   comparisonCompleteCoverage:false,
   rosterChanges:{totalRemoved:1,totalAdded:0,added:[],removed:[
    expect.objectContaining({employeeName:"Sarah Jones",date:"2026-10-13",
      start:"16:00",end:"17:00",break_minutes:0}),
   ]}});
  expect(mocks.optimizer).toHaveBeenCalledTimes(2);
  const snapshot=mocks.optimizer.mock.calls[0][0];
  const hypothetical=mocks.optimizer.mock.calls[1][0];
  expect(hypothetical).not.toBe(snapshot);
  expect(hypothetical.employees[0].exceptions).toEqual([{
   local_date:"2026-10-13",exception_type:"unavailable",
   confirmation:"owner_confirmed",
  }]);
  expect(snapshot.employees[0].exceptions).toEqual([]);
  expect(mocks.draft).not.toHaveBeenCalled();
 });
 it("refuses ambiguous same-name worker instead of pretending one was selected",async()=>{
  const people=[{id:"emp-a",displayName:"Sam Lee"},{id:"emp-b",displayName:"Sam Lee"}];
  mocks.load.mockResolvedValue({...saved,input:{...input,employees:people}});
  const result=await previewOliviaAbsenceWhatIf({
    week:"2026-10-12",employeeName:"Sam",weekday:2});
  expect(result).toMatchObject({ok:false,error:"employee_ambiguous"});
  expect(result).toHaveProperty("candidates",[
   {id:"emp-a",name:"Sam Lee"},{id:"emp-b",name:"Sam Lee"},
  ]);
  expect(mocks.optimizer).not.toHaveBeenCalled();
  expect(mocks.draft).not.toHaveBeenCalled();
 });

 it("never presents savings from a cheaper hypothetical that leaves required shifts uncovered",async()=>{
  const employee={id:"emp",displayName:"Sarah Jones",active:true,
    recurring:[],exceptions:[],qualifications:[]};
  mocks.load.mockResolvedValue({...saved,input:{...input,employees:[employee]}});
  const goodShift={employeeId:"emp",locationId:"loc",
    startAt:"2026-10-13T16:00:00Z",endAt:"2026-10-13T18:00:00Z",
    paidMinutes:120,breaks:[],pinned:false};
  mocks.optimizer.mockReturnValueOnce({
    status:"feasible",horizonEnd:"2026-10-18",warnings:[],
    best:{completeCoverage:true,hardConstraintsSatisfied:true,
      gaps:[],shifts:[goodShift],cost:{cashWagesCents:4200}},
  }).mockReturnValueOnce({
    status:"infeasible",horizonEnd:"2026-10-18",warnings:[],
    best:{completeCoverage:false,hardConstraintsSatisfied:false,
      gaps:[{reason:"no_confirmed_availability"}],shifts:[],
      cost:{cashWagesCents:0}},
  });
  const result=await previewOliviaAbsenceWhatIf({
    week:"2026-10-12",employeeName:"Sarah",weekday:2});
  expect(result).toMatchObject({ok:true,
    baseline:{completeCoverage:true},alternative:{completeCoverage:false},
    comparisonCompleteCoverage:false,changeInModeledCashWagesCents:null,
    laborCostDifferenceKnown:false,
    rosterChanges:{totalRemoved:1,totalAdded:0}});
  expect(mocks.draft).not.toHaveBeenCalled();
 });

 it("creates an actual weekly roster preview excluding a named worker for ONE week without changing her stored availability",async()=>{
  const sarah={id:"emp",displayName:"Sarah Jones",active:true,recurring:[],
   exceptions:[],qualifications:[]};
  const another={id:"other",displayName:"Maya Lee",active:true,recurring:[],
   exceptions:[],qualifications:[]};
  const original={...input,employees:[sarah,another]};
  mocks.load.mockResolvedValue({...saved,input:original});
  mocks.optimizer.mockReturnValue({status:"feasible",horizonEnd:"2026-10-18",
   warnings:[],best:{completeCoverage:true,hardConstraintsSatisfied:true,
    shifts:[{employeeId:"other",locationId:"loc",startAt:"2026-10-13T16:00:00Z",
     endAt:"2026-10-13T18:00:00Z",paidMinutes:120}],gaps:[],cost:{cashWagesCents:4200}},
   scenarios:[]});
  const result=await previewOliviaWeek({week:"2026-10-12",
   temporaryAbsence:{employeeName:"Sarah",weekday:2}});
  expect(result).toMatchObject({ok:true,
   temporaryConstraint:{employeeName:"Sarah Jones",absentDate:"2026-10-13",saved:false},
   plan:{status:"feasible"}});
  expect(mocks.optimizer).toHaveBeenCalledExactlyOnceWith(
   expect.objectContaining({employees:[
    expect.objectContaining({id:"emp",exceptions:[{
     local_date:"2026-10-13",exception_type:"unavailable",
     confirmation:"owner_confirmed"}]}),
    expect.objectContaining({id:"other",exceptions:[]}),
   ]}));
  expect(sarah.exceptions).toEqual([]);
  expect(another.exceptions).toEqual([]);
  expect(mocks.draft).not.toHaveBeenCalled();
 });
 it("never assigns an ambiguous same-name employee to a weekly exclusion without an owner choice",async()=>{
  const a={id:"00000000-0000-4000-8000-000000000001",displayName:"Sam Lee",
   active:true,exceptions:[],recurring:[],qualifications:[]};
  const b={...a,id:"00000000-0000-4000-8000-000000000002"};
  mocks.load.mockResolvedValue({...saved,input:{...input,employees:[a,b]}});
  expect(await previewOliviaWeek({week:"2026-10-12",
    temporaryAbsence:{employeeName:"Sam",weekday:2}})).toMatchObject({
     ok:false,error:"employee_ambiguous",candidates:[
      {id:a.id,name:"Sam Lee"},{id:b.id,name:"Sam Lee"}]});
  expect(mocks.optimizer).not.toHaveBeenCalled();
  const chosen=await previewOliviaWeek({week:"2026-10-12",
   temporaryAbsence:{employeeName:"Sam",weekday:2,
    selectedEmployeeIds:[b.id]}});
  expect(chosen).toMatchObject({ok:true,
   temporaryConstraint:{employeeName:"Sam Lee",absentDate:"2026-10-13",saved:false}});
  const selected=mocks.optimizer.mock.calls[0][0].employees;
  expect(selected[0].exceptions).toEqual([]);
  expect(selected[1].exceptions).toMatchObject([{local_date:"2026-10-13",
   exception_type:"unavailable"}]);
 });
});
