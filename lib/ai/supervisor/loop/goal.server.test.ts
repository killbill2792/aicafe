import {describe,expect,it,vi} from "vitest";
const reads=vi.hoisted(()=>({days:[] as string[]}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("@/lib/data/metricDay.server",()=>({readMetricDay:async(_b:string,date:string)=>{
  reads.days.push(date);
  // Certified day: 100 orders, net sales 800.00 before 1 Oct and 840.00 after.
  const net=date>="2026-10-01"?84_000:80_000;
  return {date,salesTotalCoverageVerified:true,transactionCountVerified:true,
    facts:{date,netSalesCents:net,ordersCount:100,drinksCount:0,ingredientsCents:0,wagesCents:0,staffTaxCents:0,
      cardFeesCents:0,voidsCents:0,salesDataStatus:"actual"}};
}}));
import {goalCapability} from "./goal.server";
import {goalEffectSchema} from "@/lib/calc/goals/goalSpec";

const scope={businessId:"b0000000-0000-4000-8000-000000000001",ownerUserId:"u0000000-0000-4000-8000-000000000001",
  threadId:"t0000000-0000-4000-8000-000000000001",locale:"en" as const};
const effect=goalEffectSchema.parse({title:"Average ticket up 5%",days:7,proposedOn:"2026-10-01",
  baselineFrom:"2026-09-17",baselineTo:"2026-09-30",currency:"USD",metrics:[
    {id:"primary",role:"primary",metricKey:"avg_ticket",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:5},
    {id:"guardrail1",role:"guardrail",metricKey:"orders",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:-10}]});

describe("goal capability",()=>{
  it("confirming a goal has no side effect",async()=>{
    expect(await goalCapability.commit(scope,effect)).toEqual({status:"verified",evidenceSource:"goal_tracking"});
  });
  it("records the day and the matching before-period weekdays, reading each day once",async()=>{
    reads.days=[];
    const sample=await goalCapability.monitor(scope,effect,"2026-10-02");
    expect(reads.days.sort()).toEqual(["2026-09-18","2026-09-25","2026-10-02"]);
    expect(sample).toMatchObject({businessDate:"2026-10-02",source:"metric_catalog",observation:{
      values:{primary:{value:840,coverage:1},guardrail1:{value:100,coverage:1}},
      baseline:{primary:[{date:"2026-09-25",value:800,coverage:1},{date:"2026-09-18",value:800,coverage:1}]}}});
  });
  it("reports a met goal to the inbox and chat, and a halfway update while running",async()=>{
    const samples=await Promise.all(["2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07","2026-10-08"]
      .map(async d=>(await goalCapability.monitor(scope,effect,d))!));
    const final=await goalCapability.report(scope,effect,samples,true);
    expect(final).toMatchObject({status:"complete",recommendation:"keep",
      result:{evaluationStatus:"met"},delivery:{taskKind:"goal_report",agentId:"leo",confidence:"high"}});
    expect(final.delivery?.threadText).toContain("Goal report for Average ticket up 5%: met.");
    expect(final.midRunText).toBeUndefined();
    const running=await goalCapability.report(scope,effect,samples.slice(0,3),false);
    expect(running.status).toBe("in_progress");
    expect(running.midRunText).toMatch(/^Halfway update on Average ticket up 5%/);
    expect(running.delivery?.payload.text).toBe(running.midRunText);
  });
});
