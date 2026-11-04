import {describe,expect,it} from "vitest";
import {z} from "zod";
import {approveLoop,loopRegistry,proposeLoop,registerLoopCapability,ProposalOverlapError,type LoopCreate,type LoopProposal,
  type LoopRepository,type OwnerLoopScope} from "./engine";
import {runningOverlapResult} from "@/lib/ai/agent/tools/priceExperiment";

const scope:OwnerLoopScope={businessId:"cafe",ownerUserId:"owner",threadId:"thread-2",locale:"en"};
const effectSchema=z.strictObject({productId:z.string(),productName:z.string(),oldPriceCents:z.number().int(),newPriceCents:z.number().int()});
// Same dependency scope shape as the real price test and price change capabilities.
const priceTest=registerLoopCapability({id:"alex.drink_price_experiment.v1",version:1,
  inputSchema:z.strictObject({productId:z.string(),newPriceCents:z.number().int()}),effectSchema,
  dependencyScope:(effect)=>({version:2,kind:"menu_price",productId:effect.productId}),
  simulate:async(_s,input)=>({effect:{productId:input.productId,productName:"Latte",oldPriceCents:785,newPriceCents:input.newPriceCents},
    baseline:{},monitorSpec:{durationDays:7,metricScope:input.productId}}),
  commit:async()=>({status:"requires_manual_action",instructionKey:"x",instructions:{}}),
  monitor:async()=>null,report:async()=>({status:"in_progress",result:{},recommendation:"adjust",source:"x"})});
const registry=loopRegistry(priceTest);

const running=(over:Partial<LoopProposal>):LoopProposal=>({id:"test-1",businessId:"cafe",ownerUserId:"owner",threadId:"thread-1",
  capabilityId:"alex.drink_price_experiment.v1",capabilityVersion:1,
  canonicalEffectPayload:{productId:"latte",productName:"Latte",oldPriceCents:775,newPriceCents:785},effectHash:"h",baseline:{},
  monitorSpec:{durationDays:7,metricScope:"latte"},status:"manual_confirmed",revision:3,locale:"en",
  monitoringStartDate:"2026-10-31",createdAt:"2026-10-30T00:00:00Z",...over});

function repo(active:LoopProposal[],today:string){
  const created:LoopCreate[]=[];
  // A café in UTC whose local "today" is fixed by the active window under test.
  const r:LoopRepository={cafeTimezone:async()=>"UTC",activeProposals:async()=>active,
    create:async(_s,_k,p)=>{created.push(p);return {...p,id:"new",status:"draft",revision:1,monitoringStartDate:null,createdAt:today};},
    load:async()=>{throw new Error("unused");},transition:async()=>{throw new Error("unused");},
    addSample:async()=>{},clearSample:async()=>{},samples:async()=>[],saveReport:async()=>{}};
  return {r,created};
}
const realToday=new Date().toISOString().slice(0,10);
const daysFrom=(n:number)=>new Date(Date.parse(realToday+"T00:00:00Z")+n*86_400_000).toISOString().slice(0,10);

describe("one active test per item",()=>{
  it("refuses a second latte test while the first one's window is open, and creates nothing",async()=>{
    const {r,created}=repo([running({monitoringStartDate:daysFrom(-4)})],realToday);
    const error=await proposeLoop(scope,registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},
      "00000000-0000-4000-a000-000000000001").catch(e=>e);
    expect(error).toBeInstanceOf(ProposalOverlapError);
    expect((error as ProposalOverlapError).running).toEqual({proposalId:"test-1",threadId:"thread-1",
      capabilityId:"alex.drink_price_experiment.v1",status:"manual_confirmed",monitoringStartDate:daysFrom(-4),endsOn:daysFrom(2)});
    expect(created).toEqual([]);
  });

  it("refuses while the first test is still waiting on the owner's POS change",async()=>{
    const {r,created}=repo([running({status:"manual_pending",monitoringStartDate:null})],realToday);
    await expect(proposeLoop(scope,registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"k"))
      .rejects.toBeInstanceOf(ProposalOverlapError);
    expect(created).toEqual([]);
  });

  it("allows it once the first window has ended, and allows a different item",async()=>{
    const ended=repo([running({monitoringStartDate:daysFrom(-10)})],realToday);
    await expect(proposeLoop(scope,registry,ended.r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"k"))
      .resolves.toMatchObject({status:"draft"});
    const other=repo([running({monitoringStartDate:daysFrom(-4)})],realToday);
    await expect(proposeLoop(scope,registry,other.r,"alex.drink_price_experiment.v1",{productId:"mocha",newPriceCents:650},"k"))
      .resolves.toMatchObject({status:"draft"});
    expect(other.created).toHaveLength(1);
  });

  it("the chat tool tells the model what is running and that nothing was created",async()=>{
    const {r}=repo([running({monitoringStartDate:daysFrom(-4)})],realToday);
    const error=await proposeLoop(scope,registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"k").catch(e=>e);
    expect(runningOverlapResult(error,"price_experiment_proposal")).toMatchObject({source:"price_experiment_proposal",
      draft:false,saved:false,missing:["runningExperimentSameItem"],
      runningExperiment:{proposalId:"test-1",status:"manual_confirmed",endsOn:daysFrom(2)}});
    expect(runningOverlapResult(new Error("other"),"x")).toBeNull();
  });
});

/** Shared in-memory ledger with the database's row rules: approve only from draft, reject from
 * draft/approved, each a single atomic row step. Every call yields, so concurrent calls interleave. */
class RaceRepo implements LoopRepository{
  rows=new Map<string,LoopProposal>();
  private tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
  async cafeTimezone(){return "UTC";}
  async activeProposals(){await this.tick();
    return [...this.rows.values()].filter(p=>["approved","executing","manual_pending","manual_confirmed","committed"].includes(p.status));}
  async create(s:OwnerLoopScope,key:string,p:LoopCreate){await this.tick();
    const row:LoopProposal={...p,id:key,status:"draft",revision:1,monitoringStartDate:null,createdAt:new Date().toISOString()};
    this.rows.set(key,row);return row;}
  async load(_s:OwnerLoopScope,id:string){await this.tick();return {...this.rows.get(id)!};}
  async transition(_s:OwnerLoopScope,id:string,revision:number,action:string){await this.tick();
    const p=this.rows.get(id)!;
    if(p.revision!==revision)throw new Error("proposal_revision_conflict");
    const next=action==="approve"&&p.status==="draft"?"approved":action==="reject"&&["draft","approved"].includes(p.status)?"rejected":null;
    if(!next)throw new Error("invalid transition");
    const row={...p,status:next as LoopProposal["status"],revision:p.revision+1};this.rows.set(id,row);return row;}
  async addSample(){}async clearSample(){}async samples(){return [];}async saveReport(){}
}
const ownScope=(thread:string):OwnerLoopScope=>({...scope,threadId:thread});
const active=(r:RaceRepo)=>[...r.rows.values()].filter(p=>p.status==="approved").map(p=>p.id);

describe("concurrent proposals on the same item",()=>{
  it("two proposals created at the same moment are both inert drafts; approval decides",async()=>{
    const r=new RaceRepo();
    const [a,b]=await Promise.all([
      proposeLoop(ownScope("t-a"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:785},"a"),
      proposeLoop(ownScope("t-b"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"b")]);
    expect([a.status,b.status]).toEqual(["draft","draft"]);
    expect(active(r)).toEqual([]);
  });

  it("two approvals at the same moment can never both stay active",async()=>{
    const r=new RaceRepo();
    await proposeLoop(ownScope("t-a"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:785},"a");
    await proposeLoop(ownScope("t-b"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"b");
    const results=await Promise.allSettled([approveLoop(ownScope("t-a"),r,"a",1,registry),approveLoop(ownScope("t-b"),r,"b",1,registry)]);
    expect(active(r).length).toBeLessThanOrEqual(1);
    for(const result of results)if(result.status==="rejected")expect(result.reason).toBeInstanceOf(ProposalOverlapError);
    // Every refused approval was backed out, not left half-approved.
    expect(results.filter(x=>x.status==="fulfilled").length).toBe(active(r).length);
  });

  it("one after the other: the second is refused before it is approved",async()=>{
    const r=new RaceRepo();
    await proposeLoop(ownScope("t-a"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:785},"a");
    await proposeLoop(ownScope("t-b"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:795},"b");
    await approveLoop(ownScope("t-a"),r,"a",1,registry);
    const error=await approveLoop(ownScope("t-b"),r,"b",1,registry).catch(e=>e);
    expect(error).toBeInstanceOf(ProposalOverlapError);
    expect((error as ProposalOverlapError).running.proposalId).toBe("a");
    expect(r.rows.get("b")?.status).toBe("draft");
    expect(active(r)).toEqual(["a"]);
  });

  it("a different item is approved normally",async()=>{
    const r=new RaceRepo();
    await proposeLoop(ownScope("t-a"),registry,r,"alex.drink_price_experiment.v1",{productId:"latte",newPriceCents:785},"a");
    await proposeLoop(ownScope("t-b"),registry,r,"alex.drink_price_experiment.v1",{productId:"mocha",newPriceCents:650},"b");
    await Promise.all([approveLoop(ownScope("t-a"),r,"a",1,registry),approveLoop(ownScope("t-b"),r,"b",1,registry)]);
    expect(active(r).sort()).toEqual(["a","b"]);
  });
});
