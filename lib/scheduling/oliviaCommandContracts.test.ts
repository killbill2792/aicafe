import { describe, expect, it } from "vitest";
import { oliviaPrepareAvailabilitySchema, oliviaConfirmedCommitSchema,
  oliviaCreateDraftSchema } from "./oliviaCommandContracts";
import { reconcileOliviaAvailability, oliviaProposalDigest } from "./oliviaAvailabilityProposal";
import type { OliviaReadResponse } from "./oliviaCapabilityContracts";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOC="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXIST="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN="f".repeat(32);
const uuid=()=> "ffffffff-ffff-4fff-8fff-ffffffffffff";

const employees=[
  {employeeId:A,displayName:"Ana",active:true,state:"confirmed" as const,
    recurring:[
      {id:EXIST,revision:3,employee_id:A,location_id:null,day_of_week:1,
        start_local:"08:00",end_local:"16:00",overnight:false,
        effective_from:"2026-10-19",effective_to:null,
        source:"owner_direct",confirmation:"owner_confirmed"},
      {id:OTHER,revision:2,employee_id:A,location_id:null,day_of_week:2,
        start_local:"09:00",end_local:"14:00",overnight:false,
        effective_from:"2026-10-19",effective_to:null,
        source:"worker_reported_by_owner",confirmation:"unconfirmed"},
    ],exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[]},
  {employeeId:B,displayName:"Bea",active:true,state:"missing" as const,
    recurring:[],exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[]},
] satisfies Extract<OliviaReadResponse,{ok:true;capability:"olivia.availability.read"}>["employees"];

function prepare(){
  return oliviaPrepareAvailabilitySchema.parse({
    capability:"olivia.availability.prepare",version:1,
    changes:[
      {kind:"availability_rule",employee:{exactDisplayName:"ana"},
       locationId:null,scope:{effective_from:"2026-10-19",effective_to:null},
       operations:[{action:"replace",id:EXIST,expectedRevision:3,
         data:{day_of_week:1,start_local:"07:00",end_local:"15:00",
           overnight:false,source:"worker_reported_by_owner"}}]},
      {kind:"availability_exception",employee:{employeeId:B},
       locationId:LOC,scope:{local_date:"2026-10-22"},
       operations:[{action:"add",data:{exception_type:"unavailable",
         start_local:null,end_local:null,overnight:false,
         source:"owner_direct"}}]},
    ],
  });
}

describe("Olivia PR4B-A strict scheduling commands",()=>{
  it("reconciles multiple employees, revises only targeted window and retains unrelated records",()=>{
    const result=reconcileOliviaAvailability(prepare(),employees,A,TOKEN,uuid);
    expect(result.ok).toBe(true);
    if(!result.ok)return;
    expect(result.proposal.batches).toHaveLength(2);
    const first=result.proposal.batches[0];
    expect(first.expected).toEqual([{id:EXIST,revision:3},{id:OTHER,revision:2}]);
    expect(first.desired).toHaveLength(2);
    expect(first.desired.find(r=>r.id===OTHER)?.data).toMatchObject({
      start_local:"09:00",confirmation:"unconfirmed",source:"worker_reported_by_owner",
    });
    expect(first.desired.find(r=>r.id===EXIST)?.data).toMatchObject({
      start_local:"07:00",confirmation:"owner_confirmed",
      source:"worker_reported_by_owner",
    });
    expect(result.proposal.batches[1].desired[0].data).toMatchObject({
      employee_id:B,location_id:LOC,local_date:"2026-10-22",
      exception_type:"unavailable",confirmation:"owner_confirmed",
    });
    expect(result.proposalDigest).toBe(oliviaProposalDigest(result.proposal));
    expect(result.proposal.disposition).toBe(
      "requires_separate_authenticated_owner_action");
  });

  it("clears old exception hours when replacing with an all-day absence",()=>{
    const request=oliviaPrepareAvailabilitySchema.parse({
      capability:"olivia.availability.prepare",version:1,changes:[{
        kind:"availability_exception",employee:{employeeId:A},
        locationId:null,scope:{local_date:"2026-10-21"},
        operations:[{action:"replace",id:EXIST,expectedRevision:3,
          data:{exception_type:"unavailable",overnight:false,source:"owner_direct"}}],
      }],
    });
    const previous={...employees[0],recurring:[],exceptions:[{
      id:EXIST,revision:3,employee_id:A,location_id:null,
      local_date:"2026-10-21",exception_type:"hours_cap" as const,
      start_local:null,end_local:null,overnight:false,
      max_minutes:120,source:"owner_direct" as const,
      confirmation:"owner_confirmed" as const,
    }]};
    const result=reconcileOliviaAvailability(request,[previous,employees[1]],A,TOKEN,uuid);
    expect(result.ok).toBe(true);
    if(!result.ok)return;
    const data=result.proposal.batches[0].desired[0].data;
    expect(data).toMatchObject({
      exception_type:"unavailable",start_local:null,end_local:null,
      max_minutes:null,confirmation:"owner_confirmed",
    });
    const unsafe=structuredClone(result.proposal);
    delete (unsafe.batches[0].desired[0].data as {start_local?:string|null}).start_local;
    expect(oliviaConfirmedCommitSchema.safeParse({
      capability:"olivia.availability.commit",version:1,
      proposal:unsafe,proposalDigest:oliviaProposalDigest(unsafe),
      requestKey:uuid(),
    }).success).toBe(false);
  });

  it("rejects stale revisions, foreign employee IDs and ambiguous names",()=>{
    const stale=prepare();
    stale.changes[0].operations[0]={action:"remove",id:EXIST,expectedRevision:2};
    expect(reconcileOliviaAvailability(stale,employees,A,TOKEN,uuid))
      .toMatchObject({ok:false,error:"revision_conflict"});
    const foreign=prepare();
    foreign.changes[1].employee={employeeId:"11111111-1111-4111-8111-111111111111"};
    expect(reconcileOliviaAvailability(foreign,employees,A,TOKEN,uuid))
      .toMatchObject({ok:false,error:"not_found"});
    const duplicates=[...employees,{...employees[0],employeeId:B}];
    expect(reconcileOliviaAvailability(prepare(),duplicates,A,TOKEN,uuid))
      .toMatchObject({ok:false,error:"ambiguous_employee"});
  });

  it("rejects duplicates, invented dates, working hours and model confirmation flags",()=>{
    const same=prepare();
    same.changes.push(same.changes[0]);
    expect(reconcileOliviaAvailability(same,employees,A,TOKEN,uuid))
      .toMatchObject({ok:false,error:"invalid_input"});
    expect(oliviaPrepareAvailabilitySchema.safeParse({
      ...prepare(),changes:[{...prepare().changes[0],
        scope:{effective_from:"2026-02-30",effective_to:null}}],
    }).success).toBe(false);
    const model=prepare();
    (model.changes[0].operations as unknown[])[0]={action:"add",data:{
      day_of_week:1,start_local:"sometime",end_local:"15:00",
      overnight:false,source:"owner_direct",confirmation:"owner_confirmed",
    }};
    expect(oliviaPrepareAvailabilitySchema.safeParse(model).success).toBe(false);
    const invalidWindow=prepare();
    invalidWindow.changes[0].operations[0]={action:"add",data:{
      day_of_week:1,start_local:"08:00",end_local:"08:00",
      overnight:false,source:"owner_direct",
    }};
    expect(oliviaPrepareAvailabilitySchema.safeParse(invalidWindow).success)
      .toBe(false);
    const missingExceptionHours=prepare();
    missingExceptionHours.changes[1].operations[0]={action:"add",data:{
      exception_type:"replace_day",overnight:false,source:"owner_direct",
    }};
    expect(oliviaPrepareAvailabilitySchema.safeParse(missingExceptionHours).success)
      .toBe(false);
    const invalidCap=prepare();
    invalidCap.changes[1].operations[0]={action:"add",data:{
      exception_type:"hours_cap",overnight:false,source:"owner_direct",
    }};
    expect(oliviaPrepareAvailabilitySchema.safeParse(invalidCap).success)
      .toBe(false);
    expect(oliviaConfirmedCommitSchema.safeParse({
      capability:"olivia.availability.commit",version:1,requestKey:uuid(),
      proposalDigest:"1".repeat(64),proposal:{},confirmed:true,
    }).success).toBe(false);
    expect(oliviaCreateDraftSchema.safeParse({
      capability:"olivia.schedule.draft.create",version:1,
      week:"2026-10-20",objective:"cash",expectedRevision:0,
      expectedSourceDigest:"a".repeat(64),requestKey:uuid(),
    }).success).toBe(false);
  });

  it("does not create a cross-tenant or inactive employee proposal",()=>{
    const inactive=[{...employees[0],active:false},employees[1]];
    expect(reconcileOliviaAvailability(prepare(),inactive,A,TOKEN,uuid))
      .toMatchObject({ok:false,error:"inactive_employee"});
  });
});
