import {describe,expect,it} from "vitest";
import {z} from "zod";
import {loopRegistry,proposeLoop,registerLoopCapability,ProposalOverlapError,type LoopCreate,type LoopProposal,
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
