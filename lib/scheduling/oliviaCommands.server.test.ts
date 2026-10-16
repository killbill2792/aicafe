import { beforeEach, describe, expect, it, vi } from "vitest";

const m=vi.hoisted(()=>({owner:vi.fn(),read:vi.fn(),save:vi.fn(),rpc:vi.fn(),actor:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./foundation.server",()=>({requireSchedulingOwner:m.owner}));
vi.mock("./oliviaCapabilities.server",()=>({executeOliviaReadCapability:m.read}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({saveOliviaWeekDraft:m.save}));
import { prepareOliviaAvailabilityCommand, commitOliviaConfirmedAvailability,
  createOliviaScheduleDraftCommand } from "./oliviaCommands.server";
import { attestOliviaOwnerActionFromTrustedUI } from "./oliviaOwnerAction.server";
import { oliviaConfirmedCommitSchema } from "./oliviaCommandContracts";

const id=(n:number)=>"10000000-0000-4000-8000-"+String(n).padStart(12,"0");
const cafe=id(90),otherCafe=id(91),employee=id(1),second=id(2),location=id(3);
const key=id(99),week="2026-10-19",token="a".repeat(32),digest="b".repeat(64);
const person=(employeeId:string,name:string)=>({
  employeeId,displayName:name,active:true,state:"missing",recurring:[],
  exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[],
});
let employees=[person(employee,"Ana"),person(second,"Bea")];
const proposed=()=>({
  capability:"olivia.availability.prepare",version:1,
  changes:[employee,second].map((employeeId,index)=>({
    kind:"availability_exception",employee:{employeeId},locationId:null,
    scope:{local_date:index?"2026-10-21":"2026-10-20"},
    operations:[{action:"add",data:{exception_type:"unavailable",
      start_local:null,end_local:null,overnight:false,
      source:"worker_reported_by_owner"}}],
  })),
});
const availability=()=>({ok:true,capability:"olivia.availability.read",version:1,
  source:{businessId:cafe},employees});
const shift={employeeId:employee,locationId:location,
  startAt:"2026-10-19T09:00:00.000Z",endAt:"2026-10-19T13:00:00.000Z",
  paidMinutes:240,breaks:[],pinned:false};
const scenario={
  objective:"cash",shifts:[shift],gaps:[],
  completeCoverage:true,hardConstraintsSatisfied:true,ownerMinutes:0,
  cost:{cashWagesCents:null,allocatedSalaryCents:null,loadedPayrollCents:null,
    ownerOpportunityCents:0,ownerMinutes:0,costState:"unavailable",
    missingWageEmployeeIds:[employee]},
  preferencePenalty:0,exploredNodes:10,legalReview:"unverified_profile",
};
const preview=()=>({ok:true,capability:"olivia.schedule.preview",version:1,
  source:{businessId:cafe},selectedScenario:scenario,
  plan:{warnings:["Unknown employee wage"]},
  notices:[{code:"wage_unknown",employeeName:"Ana"},{code:"policy_unverified"}],
  blockers:[]});
const revision=()=>({ok:true,capability:"olivia.schedule.revision.read",version:1,
  source:{businessId:cafe},revisionId:id(40),revision:1,
  revisionStatus:"draft",sourceDigest:digest,scenario,assignments:[shift]});

describe("Olivia PR4B-A authorized domain commands",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    employees=[person(employee,"Ana"),person(second,"Bea")];
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_AVAILABILITY_UI_ENABLED="true";
    m.actor.mockResolvedValue({data:{user:{id:id(6)}},error:null});
    m.owner.mockImplementation(async()=>({businessId:cafe,
      supabase:{auth:{getUser:m.actor},rpc:m.rpc}}));
    m.rpc.mockResolvedValue({data:token,error:null});
    m.read.mockImplementation(async(req:{capability:string})=>
      req.capability==="olivia.availability.read"?availability():
      req.capability==="olivia.schedule.preview"?preview():revision());
    m.save.mockResolvedValue({ok:true,seriesId:id(41),revisionId:id(40),
      revision:1,replayed:false,scenario});
  });

  it("prepares two employees using trusted reads without writing",async()=>{
    const prepared=await prepareOliviaAvailabilityCommand(proposed());
    expect(prepared).toMatchObject({ok:true,status:"prepared",
      requiresOwnerAction:true,proposal:{businessId:cafe,batches:[{},{}]}});
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc).toHaveBeenCalledWith("scheduling_owner_source_token",
      {p_business_id:cafe});
  });

  it("ignores model confirmation and rejects missing owner-action proof",async()=>{
    const prepared=await prepareOliviaAvailabilityCommand(proposed());
    if(!prepared.ok)throw Error("expected proposal");
    const cmd={capability:"olivia.availability.commit",version:1,
      proposal:prepared.proposal,proposalDigest:prepared.proposalDigest,
      requestKey:key};
    expect(await commitOliviaConfirmedAvailability({...cmd,confirmed:true},{} as never))
      .toMatchObject({ok:false,error:"invalid_input"});
    const validated=oliviaConfirmedCommitSchema.safeParse(cmd);
    if(!validated.success) throw Error(JSON.stringify(validated.error.issues));
    expect(await commitOliviaConfirmedAvailability(cmd,{} as never))
      .toMatchObject({ok:false,error:"unauthorized"});
    expect(m.rpc.mock.calls.some(x=>x[0]==="scheduling_olivia_commit_availability"))
      .toBe(false);
  });

  it("consumes one owner proof and reads back exact saved rows for both employees",async()=>{
    const prepared=await prepareOliviaAvailabilityCommand(proposed());
    if(!prepared.ok)throw Error("expected proposal");
    const cmd={capability:"olivia.availability.commit",version:1,
      proposal:prepared.proposal,proposalDigest:prepared.proposalDigest,
      requestKey:key};
    const validated=oliviaConfirmedCommitSchema.safeParse(cmd);
    if(!validated.success) throw Error(JSON.stringify(validated.error.issues));
    const attestation=await attestOliviaOwnerActionFromTrustedUI({
      proposalDigest:prepared.proposalDigest,requestKey:key});
    if(!attestation.ok)throw Error("expected authenticated owner proof");
    m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
      if(name!=="scheduling_olivia_commit_availability")return {data:token,error:null};
      const batches=args.p_batches as typeof prepared.proposal.batches;
      for(let i=0;i<batches.length;i++){
        const record=batches[i].desired[0].data;
        employees[i].exceptions=[{...record,id:id(70+i),revision:1} as never];
      }
      return {error:null,data:{actorId:id(6),replayed:false,
        batches:batches.map((_,i)=>({batchIndex:i,
          records:[{id:id(70+i),revision:1}]}))}};
    });
    expect(await commitOliviaConfirmedAvailability(cmd,attestation.proof))
      .toMatchObject({ok:true,status:"committed",replayed:false,
        disposition:"saved_availability_only"});
    expect(await commitOliviaConfirmedAvailability(cmd,attestation.proof))
      .toMatchObject({ok:false,error:"unauthorized"});
  });

  it("fails on source token changes and tenant switches",async()=>{
    m.rpc.mockResolvedValueOnce({data:token,error:null})
      .mockResolvedValueOnce({data:"c".repeat(32),error:null});
    expect(await prepareOliviaAvailabilityCommand(proposed()))
      .toMatchObject({ok:false,error:"source_changed"});
    m.owner.mockResolvedValue({businessId:otherCafe,
      supabase:{auth:{getUser:m.actor},rpc:m.rpc}});
    expect(await prepareOliviaAvailabilityCommand(proposed()))
      .toMatchObject({ok:false,error:"invalid_record"});
  });

  it("saves draft from PR3, but missing wage/policy prevents approval readiness",async()=>{
    const args={capability:"olivia.schedule.draft.create",version:1,week,
      objective:"cash",expectedSourceDigest:digest,expectedRevision:0,requestKey:key};
    expect(await createOliviaScheduleDraftCommand(args)).toMatchObject({
      ok:true,status:"saved_draft",revisionStatus:"draft",
      readyForOwnerApproval:false,readyForPublication:false,
      costs:{costState:"unavailable"}});
    expect(m.save).toHaveBeenCalledWith({week,objective:"cash",
      expectedSourceDigest:digest,expectedRevision:0,requestKey:key});
    m.read.mockImplementation(async(req:{capability:string})=>
      req.capability==="olivia.schedule.preview"?preview():
      {...revision(),scenario:{...scenario,shifts:[]},assignments:[]});
    expect(await createOliviaScheduleDraftCommand({...args,requestKey:id(98)}))
      .toMatchObject({ok:false,error:"invalid_record"});
  });
});
