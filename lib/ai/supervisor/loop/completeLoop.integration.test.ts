import {describe,it,expect} from "vitest";
import {z} from "zod";
import {evaluatePriceExperiment,simulatePriceExperiment,type PriceExperimentBaseline,
  type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {registerLoopCapability,loopRegistry,simulateLoop,proposeLoop,approveLoop,
  commitLoop,confirmManualLoop,monitorLoop,type LoopRepository,type OwnerLoopScope,
  type LoopProposal,type LoopCreate,type LoopSample,type LoopReport} from "./engine";
const scope:OwnerLoopScope={businessId:"4d3ff57f-67dd-4f89-a88c-2242e6a2ba66",
  ownerUserId:"e106f379-dba3-4e35-847f-e784132d91cb",
  threadId:"b1075c9f-d765-431b-9042-2c2eb68e9008",locale:"en"};
const effectSchema=z.strictObject({productId:z.uuid(),productName:z.string(),
  oldPriceCents:z.number().int().nonnegative(),newPriceCents:z.number().int().nonnegative(),
  ingredientCostCents:z.number().int().nonnegative(),baselineUnits7Days:z.number().int().nonnegative(),
  currency:z.literal("USD"),estimateKind:z.literal("conditional_unchanged_demand")});
const item="f6082eaa-e0c4-41de-9856-11b870bf6c35";
const observed:PriceExperimentDay[]=Array.from({length:7},(_,i)=>({
  businessDate:`2026-10-${String(i+1).padStart(2,"0")}`,
  units:10,netSalesCents:5100,coverage:"actual",source:"order_lines+daily_rollups"}));
const latte=registerLoopCapability({
 id:"alex.price_experiment.integration.v1",version:1,
 inputSchema:z.strictObject({increaseCents:z.number().int().positive()}),effectSchema,
 simulate:async(_scope,input)=>{
   const scenario=simulatePriceExperiment({productId:item,productName:"Latte",currentPriceCents:500,
     increaseCents:input.increaseCents,ingredientCostCents:125,units7Days:70});
   if(!scenario)throw new Error("unavailable");
   const {beforeContributionCents,afterContributionCents,
     estimatedAdditionalRevenue7DaysCents,estimatedAdditionalContribution7DaysCents,
     ...effect}=scenario;
   return {effect,baseline:{beforeContributionCents,afterContributionCents,
      estimatedAdditionalRevenue7DaysCents,estimatedAdditionalContribution7DaysCents},
      monitorSpec:{durationDays:7,metricScope:item}};
 },
 commit:async()=>({status:"requires_manual_action",instructionKey:"update_price_in_pos",
    instructions:{productName:"Latte",toPriceCents:"510"}}),
 monitor:async(_scope,_effect,businessDate)=>{
   const day=observed.find(d=>d.businessDate===businessDate);
   return day?{businessDate,observation:day as unknown as Record<string,unknown>,
     source:day.source}:null;
 },
 report:async(_scope,effect,samples)=>{
   const baseline:PriceExperimentBaseline=effect;
   const days=samples.map(x=>x.observation as PriceExperimentDay);
   const result=evaluatePriceExperiment(baseline,days,7);
   return {status:result.status,result,source:"order_lines+daily_rollups",
     recommendation:result.recommendation};
 },
});
const bill=registerLoopCapability({
 id:"bills.review.integration.v1",version:1,
 inputSchema:z.strictObject({billId:z.uuid()}),
 effectSchema:z.strictObject({billId:z.uuid(),review:z.literal(true)}),
 simulate:async(_scope,input)=>({effect:{billId:input.billId,review:true},
   baseline:{source:"owner"},monitorSpec:{durationDays:1,metricScope:"bill_status"}}),
 commit:async()=>({status:"requires_manual_action",instructionKey:"mark_bill_reviewed",
   instructions:{billId:"owner-action"}}),
 monitor:async(_scope,effect,businessDate)=>({businessDate,source:"review_status",
   observation:{reviewed:effect.review}}),
 report:async()=>({status:"complete",result:{reviewed:true},
   recommendation:"keep",source:"review_status"}),
});
class MemoryRepo implements LoopRepository{
 proposal:LoopProposal|null=null;
 samplesList:LoopSample[]=[];
 report:LoopReport|null=null;
 async create(s:OwnerLoopScope,_key:string,p:LoopCreate){
   const result:LoopProposal={...p,id:"fc105c42-d0c5-4bf5-a5af-5b8ecb4f490b",
     status:"draft",revision:1,monitoringStartDate:null,createdAt:"2026-09-30T00:00:00Z"};
   if(s.businessId!==p.businessId||s.ownerUserId!==p.ownerUserId)throw new Error("scope");
   this.proposal=result;return result;
 }
 async load(s:OwnerLoopScope,id:string){
   if(this.proposal?.id!==id||this.proposal.businessId!==s.businessId||
     this.proposal.ownerUserId!==s.ownerUserId||this.proposal.threadId!==s.threadId)throw new Error("scope");
   return this.proposal;
 }
 async transition(s:OwnerLoopScope,id:string,revision:number,
   action:"approve"|"reject"|"claim_commit"|"manual_pending"|"manual_confirmed"|"committed",startDate?:string){
   const p=await this.load(s,id);
   if(p.revision!==revision)throw new Error("conflict");
   const allowed=action==="approve"?p.status==="draft":
     action==="claim_commit"?p.status==="approved":
     action==="manual_pending"||action==="committed"?p.status==="executing":
     action==="manual_confirmed"?p.status==="manual_pending":
     action==="reject"?["draft","approved"].includes(p.status):false;
   if(!allowed)throw new Error("conflict");
   const status=action==="approve"?"approved":action==="reject"?"rejected":
     action==="claim_commit"?"executing":action;
   this.proposal={...p,status,revision:revision+1,
     monitoringStartDate:action==="manual_confirmed"||action==="committed"?
       startDate??null:p.monitoringStartDate};
   return this.proposal;
 }
 async addSample(s:OwnerLoopScope,id:string,sample:LoopSample){
   await this.load(s,id);
   this.samplesList=this.samplesList.filter(x=>x.businessDate!==sample.businessDate).concat(sample);
 }
 async samples(s:OwnerLoopScope,id:string){await this.load(s,id);return this.samplesList;}
 async saveReport(s:OwnerLoopScope,p:LoopProposal,report:LoopReport){
   await this.load(s,p.id);this.report=report;
 }
}
describe("owner-approved full loop with real cents-only calculator",()=>{
 it("proposes, approves, sends manual handoff, monitors 7 days, computes and reports the observed impact",async()=>{
   const registry=loopRegistry(latte,bill);
   const store=new MemoryRepo();
   const simulation=await simulateLoop(scope,registry,latte.id,{increaseCents:10});
   expect(simulation.baseline.estimatedAdditionalRevenue7DaysCents).toBe(700);
   const p=await proposeLoop(scope,registry,store,latte.id,{increaseCents:10},
     "730fedc3-cc88-4728-91e1-08c47f3c9a71");
   expect(p.status).toBe("draft");
   await expect(commitLoop(scope,registry,store,p.id,p.revision)).rejects.toThrow("Approval required");
   const approved=await approveLoop(scope,store,p.id,p.revision);
   await expect(approveLoop(scope,store,p.id,p.revision)).rejects.toThrow("conflict");
   const commit=await commitLoop(scope,registry,store,p.id,approved.revision);
   expect(commit.result).toEqual({status:"requires_manual_action",
     instructionKey:"update_price_in_pos",instructions:{productName:"Latte",toPriceCents:"510"}});
   expect(commit.proposal.status).toBe("manual_pending");
   const started=await confirmManualLoop(scope,store,p.id,commit.proposal.revision,"2026-10-01");
   expect(started.status).toBe("manual_confirmed");
   for(let i=1;i<=7;i++){
     const day=`2026-10-${String(i).padStart(2,"0")}`;
     const report=await monitorLoop(scope,registry,store,started,day);
     if(i<7)expect(report).toBeNull();
   }
   expect(store.report).toMatchObject({status:"complete",recommendation:"keep",result:{
     coveredDays:7,units:70,observedRevenueCents:35700,realizedRevenueDifferenceCents:700,
     observedIngredientContributionCents:26950}});
   expect(store.samplesList).toHaveLength(7);
 });
 it("onboards a second domain registration without any dispatcher modification",async()=>{
   const store=new MemoryRepo(),registry=loopRegistry(latte,bill);
   const p=await proposeLoop(scope,registry,store,bill.id,
     {billId:"6178f8ef-4487-4da7-a216-229079864799"},
     "83280b17-125c-4d4d-b98a-6ca92589fd5e");
   const a=await approveLoop(scope,store,p.id,p.revision);
   expect((await commitLoop(scope,registry,store,p.id,a.revision)).result.status)
     .toBe("requires_manual_action");
 });
 it("serializes two concurrent effect invocations at the approval-claim gate",async()=>{
   let commits=0;
   const effect=registerLoopCapability({
     id:"test.one_time_effect.v1",version:1,
     inputSchema:z.strictObject({value:z.number().int()}),
     effectSchema:z.strictObject({value:z.number().int()}),
     simulate:async(_scope,input)=>({effect:input,baseline:{},
       monitorSpec:{durationDays:1,metricScope:"effect"}}),
     commit:async()=>{commits++;await Promise.resolve();return {status:"verified",evidenceSource:"test"};},
     monitor:async(_scope,_effect,businessDate)=>({businessDate,source:"test",observation:{ok:true}}),
     report:async()=>({status:"complete",result:{ok:true},recommendation:"keep",source:"test"}),
   });
   const registry=loopRegistry(effect),store=new MemoryRepo();
   const draft=await proposeLoop(scope,registry,store,effect.id,{value:1},
     "9482eaf5-a2f1-4d67-852b-aab8a8d9b310");
   const approved=await approveLoop(scope,store,draft.id,draft.revision);
   const results=await Promise.allSettled([
     commitLoop(scope,registry,store,draft.id,approved.revision),
     commitLoop(scope,registry,store,draft.id,approved.revision),
   ]);
   expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
   expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
   expect(commits).toBe(1);
 });
 it("never posts a terminal report before monitoring ends",async()=>{
   const registry=loopRegistry(latte),store=new MemoryRepo();
   const p=await proposeLoop(scope,registry,store,latte.id,{increaseCents:10},
     "bd7ef968-0c42-4b6b-b386-0f4a113c5627");
   const a=await approveLoop(scope,store,p.id,p.revision);
   const commit=await commitLoop(scope,registry,store,p.id,a.revision);
   const ready=await confirmManualLoop(scope,store,p.id,commit.proposal.revision,"2026-10-01");
   const result=await monitorLoop(scope,registry,store,ready,"2026-09-30",true);
   expect(result?.status).toBe("in_progress");
   expect(store.report?.status).toBe("in_progress");
 });
 it("rejects cross-tenant approval even when proposal id and revision are known",async()=>{
   const store=new MemoryRepo(),registry=loopRegistry(latte);
   const p=await proposeLoop(scope,registry,store,latte.id,{increaseCents:10},
     "bce7565a-ceb7-4183-a6a9-50569f7c9e27");
   await expect(approveLoop({...scope,businessId:"67a208f4-ad05-4755-8ffd-23521256a24e"},
     store,p.id,p.revision)).rejects.toThrow("scope");
 });
});
