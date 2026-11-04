import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {buildExperimentsList,type ExperimentProposalRow} from "./experiments";
import {experimentHref} from "./board";
import {EXPERIMENT_CAPABILITIES} from "./experiments.server";
import {priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId} from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {goalCapabilityId} from "@/lib/ai/supervisor/loop/goal.server";
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("@/lib/ai/supervisor/loop/sales.server",()=>({readPriceExperimentBaselineUnits:vi.fn(),readPriceExperimentSalesDays:vi.fn()}));

const TODAY="2026-11-04";
const latte=(id:string,status:string,start:string|null,oldP:number,newP:number,extra:Partial<ExperimentProposalRow>={}):ExperimentProposalRow=>({
  id,thread_id:"t-"+id,status,capability_id:"alex.drink_price_experiment.v1",
  canonical_effect_payload:{productId:"latte",productName:"Latte",oldPriceCents:oldP,newPriceCents:newP,baselineUnits7Days:140},
  baseline:{estimatedAdditionalRevenue7DaysCents:1400},monitor_spec:{durationDays:7,metricScope:"latte"},
  monitoring_start_date:start,...extra});

describe("Experiments page list",()=>{
  it("lists both running latte tests with day X of Y and flags that they overlap",()=>{
    const list=buildExperimentsList([latte("a","manual_confirmed","2026-10-31",775,785),
      latte("b","manual_confirmed","2026-11-05",785,795)],[],[],TODAY);
    expect(list.running.map(e=>[e.proposalId,e.stage,e.day,e.days,e.oldPriceCents,e.newPriceCents])).toEqual([
      ["b","monitoring",0,7,785,795],["a","monitoring",5,7,775,785]]);
    expect(list.running.map(e=>e.overlapsWith)).toEqual([["a"],["b"]]);
  });

  it("shows the baseline, every daily sample and the final verdict",()=>{
    const list=buildExperimentsList([latte("a","monitored","2026-10-20",500,550)],
      [{proposal_id:"a",status:"complete",generated_at:"2026-10-27T16:00:00Z",
        report:{recommendation:"keep",realizedRevenueDifferenceCents:2100,observedRevenueCents:80000,coveredDays:7}}],
      [{proposal_id:"a",business_date:"2026-10-21",observation:{units:19,netSalesCents:10450,coverage:"actual"}},
       {proposal_id:"a",business_date:"2026-10-20",observation:{units:21,netSalesCents:11550,coverage:"actual"}},
       {proposal_id:"other",business_date:"2026-10-20",observation:{units:1}}],TODAY);
    const [e]=list.past;
    expect(e).toMatchObject({stage:"finished",baselineUnits7Days:140,estimatedRevenueCents:1400,startDate:"2026-10-20",endDate:"2026-10-26",
      verdict:{status:"complete",recommendation:"keep",revenueDifferenceCents:2100,coveredDays:7}});
    expect(e.samples).toEqual([{date:"2026-10-20",units:21,netSalesCents:11550,coverage:"actual"},
      {date:"2026-10-21",units:19,netSalesCents:10450,coverage:"actual"}]);
  });

  it("has no three-item or fourteen-day cap, unlike the Home board",()=>{
    const running=["a","b","c","d","e"].map(id=>latte(id,"manual_pending",null,500,550,{canonical_effect_payload:{productId:id,productName:id,oldPriceCents:500,newPriceCents:550}}));
    const old=latte("old","monitored","2026-08-01",500,550);
    const list=buildExperimentsList([...running,old],[{proposal_id:"old",status:"complete",report:{recommendation:"revert"},generated_at:"2026-08-08T00:00:00Z"}],[],TODAY);
    expect(list.running).toHaveLength(5);
    expect(list.past.map(e=>[e.proposalId,e.verdict?.recommendation])).toEqual([["old","revert"]]);
  });

  it("keeps an ended window without a report as 'awaiting report' instead of dropping it",()=>{
    const list=buildExperimentsList([latte("a","manual_confirmed","2026-10-20",500,550)],[],[],TODAY);
    expect(list.running.map(e=>[e.proposalId,e.stage])).toEqual([["a","awaitingReport"]]);
  });

  it("shows a goal with its met / not met verdict",()=>{
    const goal:ExperimentProposalRow={id:"g",thread_id:"t",status:"monitored",capability_id:"leo.goal.v1",
      canonical_effect_payload:{title:"Average ticket up 5%"},baseline:{},monitor_spec:{durationDays:30,metricScope:"goal"},monitoring_start_date:"2026-09-01"};
    const list=buildExperimentsList([goal],[{proposal_id:"g",status:"complete",report:{recommendation:"keep",evaluationStatus:"met"},generated_at:"2026-10-01T00:00:00Z"}],[],TODAY);
    expect(list.past[0]).toMatchObject({kind:"goal",title:"Average ticket up 5%",oldPriceCents:null,verdict:{goalMet:true}});
  });

  it("reads exactly the registered price test, price change and goal capabilities",()=>{
    expect([...EXPERIMENT_CAPABILITIES]).toEqual([priceExperimentCapabilityId,menuPriceChangeCapabilityId,goalCapabilityId]);
  });

  it("Home's Running and report lines open this page at the experiment",()=>{
    expect(experimentHref("p 1")).toBe("/operations/experiments#experiment-p%201");
  });
});
