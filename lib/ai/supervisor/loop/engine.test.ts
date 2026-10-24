import {describe,it,expect} from "vitest";
import {z} from "zod";
import {evaluatePriceExperiment,simulatePriceExperiment} from "@/lib/calc/priceExperiment";
import {billReviewFixtureCapability} from "./reviewBillFixture";
import {registerLoopCapability,loopRegistry,proposeLoop,approveLoop,commitLoop,
  confirmManualLoop,monitorLoop,simulateLoop,utcDateOffset,type LoopRepository,
  type LoopProposal,type LoopSample,type LoopReport,type OwnerLoopScope,type LoopCreate} from "./engine";
const scope:OwnerLoopScope={businessId:"business-a",ownerUserId:"owner-a",threadId:"thread-a",locale:"en"};
const calc=simulatePriceExperiment({productId:"latte-12oz",productName:"Latte 12oz",
  currentPriceCents:500,increaseCents:10,ingredientCostCents:125,units7Days:70})!;
const {beforeContributionCents:before,afterContributionCents:after,
  estimatedAdditionalRevenue7DaysCents:uplift,
  estimatedAdditionalContribution7DaysCents:_projected,...effect}=calc;
void _projected;
let commits=0;
const drinkFixture=registerLoopCapability({
 dependencyScope:(effect)=>({version:1,effect}),
  id:"alex.drink_price_experiment.v1",version:1,
  inputSchema:z.strictObject({drink:z.literal("latte-12oz")}),
  effectSchema:z.strictObject({productId:z.string(),productName:z.string(),
    oldPriceCents:z.number().int(),newPriceCents:z.number().int(),
    ingredientCostCents:z.number().int(),baselineUnits7Days:z.number().int(),
    currency:z.literal("USD"),estimateKind:z.literal("conditional_unchanged_demand")}),
  simulate:async()=>({effect,baseline:{beforeContributionCents:before,afterContributionCents:after,
    estimatedAdditionalRevenue7DaysCents:uplift},monitorSpec:{durationDays:7,metricScope:"latte-12oz"}}),
  commit:async()=>{commits++;return {status:"requires_manual_action",instructionKey:"update_price_in_pos",
    instructions:{step:"Use the external POS directly"}};},
  monitor:async(_scope,_effect,date)=>({businessDate:date,
    observation:{businessDate:date,units:10,netSalesCents:5100,coverage:"actual",
      source:"canonical_order_lines"},source:"canonical_order_lines"}),
  report:async(_scope,baseline,samples)=>{
    const actual=evaluatePriceExperiment(baseline,samples.map(s=>({
      businessDate:s.businessDate,units:Number(s.observation.units),
      netSalesCents:Number(s.observation.netSalesCents),
      coverage:"actual" as const,source:s.source
    })),7);
    return {status:actual.status,result:{...actual,estimatedAdditionalRevenue7DaysCents:uplift},
      recommendation:actual.recommendation,source:"canonical_order_lines"};
  },
});
class MemoryRepo implements LoopRepository{
  proposals=new Map<string,LoopProposal>();
  rows=new Map<string,Map<string,LoopSample>>();
  reports=new Map<string,LoopReport>();
  async create(s:OwnerLoopScope,key:string,p:LoopCreate){
    for(const old of this.proposals.values())if(old.id===key){
      if(old.effectHash!==p.effectHash)throw Error("Conflicting retry");
      return old;
    }
    const row:LoopProposal={...p,id:key,status:"draft",revision:1,
      monitoringStartDate:null,createdAt:"2026-10-20T00:00:00Z"};
    this.proposals.set(row.id,row);return row;
  }
  async load(s:OwnerLoopScope,id:string){
    const r=this.proposals.get(id);
    if(!r||r.businessId!==s.businessId||r.ownerUserId!==s.ownerUserId||
      r.threadId!==s.threadId)throw Error("Wrong scope");
    return r;
  }
  async transition(s:OwnerLoopScope,id:string,revision:number,action:
    "approve"|"reject"|"claim_commit"|"manual_pending"|"manual_confirmed"|"committed"|"finish_monitor",startDate?:string){
    const old=await this.load(s,id);
    if(old.revision!==revision)throw Error("CAS conflict");
    const allowed=action==="approve"?old.status==="draft":
      action==="reject"?["draft","approved"].includes(old.status):
      action==="claim_commit"?old.status==="approved":
      action==="manual_pending"||action==="committed"?old.status==="executing":
      action==="manual_confirmed"?old.status==="manual_pending"&&!!startDate:
      action==="finish_monitor"?["committed","manual_confirmed"].includes(old.status):false;
    if(!allowed)throw Error("Invalid transition");
    const updated:LoopProposal={...old,revision:revision+1,
      status:action==="approve"?"approved":action==="reject"?"rejected":
        action==="claim_commit"?"executing":action==="finish_monitor"?"monitored":action,
      monitoringStartDate:startDate??old.monitoringStartDate};
    this.proposals.set(id,updated);return updated;
  }
  async addSample(_s:OwnerLoopScope,id:string,sample:LoopSample){
    const map=this.rows.get(id)??new Map<string,LoopSample>();
    map.set(sample.businessDate,sample);this.rows.set(id,map);
  }
  async clearSample(_s:OwnerLoopScope,id:string,date:string){this.rows.get(id)?.delete(date);}
  async samples(_s:OwnerLoopScope,id:string){return [...(this.rows.get(id)?.values()??[])];}
  async saveReport(_s:OwnerLoopScope,p:LoopProposal,report:LoopReport){this.reports.set(p.id,report);}
}
const registry=loopRegistry(drinkFixture,billReviewFixtureCapability);
describe("end-to-end universal Supervisor execution loop",()=>{
 it("reuses one registry for multiple domains without modifying dispatcher",async()=>{
    expect(registry.list()).toContain("leo.recurring_bill_review.v1");
    const repo=new MemoryRepo();
    const draft=await proposeLoop(scope,registry,repo,"leo.recurring_bill_review.v1",
      {billId:"rent",vendor:"landlord"},"bill-id");
    const approved=await approveLoop(scope,repo,draft.id,draft.revision);
    const commit=await commitLoop(scope,registry,repo,approved.id,approved.revision);
    expect(commit.result.status).toBe("requires_manual_action");
    const confirmed=await confirmManualLoop(scope,repo,commit.proposal.id,
      commit.proposal.revision,"2026-10-21");
    const report=await monitorLoop(scope,registry,repo,confirmed,"2026-10-21");
    expect(report?.status).toBe("complete");
 });
 it("runs approved drink-price journey with 7 observed days and canonical math",async()=>{
    const repo=new MemoryRepo();
    const simulation=await simulateLoop(scope,registry,drinkFixture.id,{drink:"latte-12oz"});
    expect(simulation.baseline.estimatedAdditionalRevenue7DaysCents).toBe(700);
    expect(repo.proposals.size).toBe(0);
    const draft=await proposeLoop(scope,registry,repo,drinkFixture.id,
      {drink:"latte-12oz"},"drink-id");
    expect(draft.status).toBe("draft");
    await expect(commitLoop(scope,registry,repo,draft.id,draft.revision)).rejects.toThrow("Approval required");
    const approved=await approveLoop(scope,repo,draft.id,draft.revision);
    const result=await commitLoop(scope,registry,repo,approved.id,approved.revision);
    expect(result.result).toMatchObject({status:"requires_manual_action"});
    expect(result.proposal.status).toBe("manual_pending");
    await expect(commitLoop(scope,registry,repo,approved.id,approved.revision)).rejects.toThrow();
    expect(commits).toBeGreaterThan(0);
    const confirmed=await confirmManualLoop(scope,repo,result.proposal.id,
      result.proposal.revision,"2026-10-21");
    for(let i=0;i<6;i++){
      const day=utcDateOffset("2026-10-21",i);
      expect(await monitorLoop(scope,registry,repo,confirmed,day)).toBeNull();
    }
    const final=await monitorLoop(scope,registry,repo,confirmed,"2026-10-27");
    expect(final).toMatchObject({status:"complete",recommendation:"keep",
      result:{units:70,observedRevenueCents:35700,
        observedIngredientContributionCents:26950,
        realizedRevenueDifferenceCents:700,
        estimatedAdditionalRevenue7DaysCents:700}});
    expect(repo.reports.get(draft.id)?.status).toBe("complete");
    await monitorLoop(scope,registry,repo,confirmed,"2026-10-27");
    expect((await repo.samples(scope,draft.id))).toHaveLength(7);
 });
 it("returns an explicitly in-progress early read without inventing missing days",async()=>{
    const repo=new MemoryRepo();
    const p=await proposeLoop(scope,registry,repo,drinkFixture.id,
      {drink:"latte-12oz"},"partial-id");
    const a=await approveLoop(scope,repo,p.id,p.revision);
    const c=await commitLoop(scope,registry,repo,a.id,a.revision);
    const confirmed=await confirmManualLoop(scope,repo,c.proposal.id,c.proposal.revision,"2026-10-21");
    const partial=await monitorLoop(scope,registry,repo,confirmed,"2026-10-21",true);
    expect(partial?.status).toBe("in_progress");
    expect(partial?.result).toMatchObject({coveredDays:1,units:10,observedRevenueCents:5100});
 });
 it("finalizes missing actual coverage honestly after the window",async()=>{
    const repo=new MemoryRepo();
    const p=await proposeLoop(scope,registry,repo,drinkFixture.id,{drink:"latte-12oz"},"missing-days");
    const a=await approveLoop(scope,repo,p.id,p.revision);
    const c=await commitLoop(scope,registry,repo,a.id,a.revision);
    const confirmed=await confirmManualLoop(scope,repo,c.proposal.id,c.proposal.revision,"2026-10-21");
    const early=await monitorLoop(scope,registry,repo,confirmed,"2026-10-20",true);
    expect(early).toMatchObject({status:"in_progress",result:{status:"in_progress"}});
    const ended=await monitorLoop(scope,registry,repo,confirmed,"2026-10-28");
    expect(ended).toMatchObject({status:"insufficient_evidence",recommendation:"adjust"});
    expect(repo.reports.get(p.id)?.status).toBe("insufficient_evidence");
 });
 it("rejects cross-tenant/owner access and stale revisions",async()=>{
    const repo=new MemoryRepo();
    const p=await proposeLoop(scope,registry,repo,drinkFixture.id,
      {drink:"latte-12oz"},"security-id");
    await expect(approveLoop({...scope,businessId:"other"},repo,p.id,p.revision)).rejects.toThrow();
    await expect(approveLoop({...scope,ownerUserId:"other"},repo,p.id,p.revision)).rejects.toThrow();
    await approveLoop(scope,repo,p.id,p.revision);
    await expect(approveLoop(scope,repo,p.id,p.revision)).rejects.toThrow();
 });
});
